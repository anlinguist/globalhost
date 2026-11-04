// `globalhost cleanup`, the nightly cleanup job (P1-13 slice 2, ADR-0020): sweep what a closed PR left behind.
// Reads everything into a plan first; only then, if the plan is under the cap and the job is applying, writes.
//
// Actions logs in this repo are public. Object names and API paths can name a private repo, so nothing that holds
// one is logged or thrown from here: output is PR numbers, amounts and fixed text, and failures carry an HTTP status.
import { readFile } from "node:fs/promises";
import { ReviewLedgerSchema, type ReviewLedger } from "@globalhost/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  dispatchHoldReleasable,
  isRemovableTagEntry,
  overCap,
  planReviewPr,
  prFromDomain,
  prFromTag,
  previewVerdict,
  renderCleanupReport,
  trafficWithout,
  type CleanupReport,
  type Kept,
  type PrTruth,
} from "./cleanup.js";
import { CONTROL_BUCKET, ControlPlane, ObjectStore, gcloudAccessToken, isRepoSlug, type AccessToken } from "./gcp.js";
import { GitHubClient, GitHubError } from "./github.js";
import { failureText, GcpTokenError, READ_CONCURRENCY, mapLimited, reusedToken } from "./metrics-step.js";
import { parseSpendName, spendWindow } from "./metrics.js";

/** Where the factory's own list of preview products lives, relative to the checkout. */
export const STACK_CONFIG_PATH = "infra/factory/Pulumi.prod.yaml";
/** Re-reads when the service changes under a traffic update. */
const MAX_TRAFFIC_ATTEMPTS = 3;

/** A failure whose message is safe for a public log. */
export class CleanupError extends Error {}

const StackSchema = z.object({
  config: z
    .object({
      "gcp:region": z.string().regex(/^[a-z]+-[a-z]+[0-9]$/),
      "globalhost-factory:previews": z
        .array(
          z.object({
            product: z.string().regex(/^[a-z][a-z0-9-]{0,18}[a-z0-9]$/),
            devProject: z.string().regex(/^[a-z][a-z0-9-]{4,28}-dev$/),
            repo: z.object({ name: z.string().refine(isRepoSlug) }),
            parts: z.array(z.string().regex(/^[a-z][a-z0-9]{0,19}$/)),
          }),
        )
        .default([]),
    })
    .loose(),
});

export interface PreviewProduct {
  product: string;
  devProject: string;
  repo: string;
  parts: string[];
  region: string;
}

/** The preview products in the stack config: the same list Pulumi grants on, so the two can't disagree. */
export function parseStackProducts(text: string): PreviewProduct[] {
  const { config } = StackSchema.parse(parseYaml(text));
  return config["globalhost-factory:previews"].map((p) => ({ product: p.product, devProject: p.devProject, repo: p.repo.name, parts: p.parts, region: config["gcp:region"] }));
}

const PullSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  closed_at: z.string().nullable(),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

/** Asks GitHub about one number in a repo. Never throws: an error, a 404 (an issue's number is one) or anything odd is `unknown`. */
export async function readPrTruth(gh: GitHubClient, repo: string, pr: number, nowMs: number): Promise<PrTruth> {
  let pull: z.infer<typeof PullSchema>;
  try {
    pull = await gh.request("GET", `/repos/${repo}/pulls/${pr}`, undefined, PullSchema);
  } catch (e) {
    if (e instanceof GitHubError) return { kind: "unknown", why: e.status === 404 ? "GitHub has no such PR (404)" : `GitHub answered HTTP ${e.status}` };
    return { kind: "unknown", why: "GitHub's answer couldn't be read" };
  }
  const canonical = pull.base.repo.full_name;
  if (pull.number !== pr || canonical.toLowerCase() !== repo.toLowerCase() || !isRepoSlug(canonical)) return { kind: "unknown", why: "GitHub answered about something else" };
  if (pull.state === "open") return { kind: "open" };
  const closedAtMs = pull.closed_at === null ? Number.NaN : Date.parse(pull.closed_at);
  if (pull.state !== "closed" || Number.isNaN(closedAtMs) || closedAtMs > nowMs) return { kind: "unknown", why: "GitHub's answer isn't a clean closed PR" };
  return { kind: "closed", closedAtMs, repo: canonical };
}

// ---- Cloud Run and Identity Platform ----

// Loose, because the PATCH sends the service back whole: the API marks `template` required, and the mask limits the change.
const TrafficEntrySchema = z.looseObject({ type: z.string().optional(), percent: z.number().optional(), tag: z.string().optional() });
type RunTraffic = z.infer<typeof TrafficEntrySchema>;
const ServiceSchema = z.looseObject({ etag: z.string().min(1), traffic: z.array(TrafficEntrySchema) });
type RunService = z.infer<typeof ServiceSchema>;
/** No default: a response without the list must fail, never read as "no domains" and get written back. */
const AuthConfigSchema = z.object({ authorizedDomains: z.array(z.string()) });

class GcpApi {
  constructor(
    private readonly token: AccessToken,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async call(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    return this.fetchImpl(url, { ...init, headers: { authorization: `Bearer ${await this.token()}`, ...init.headers } });
  }

  private static serviceUrl(p: PreviewProduct, part: string) {
    return `https://run.googleapis.com/v2/projects/${p.devProject}/locations/${p.region}/services/${p.product}-${part}-preview`;
  }

  async readService(p: PreviewProduct, part: string) {
    const resp = await this.call(GcpApi.serviceUrl(p, part));
    if (!resp.ok) throw new Error(`Cloud Run read: HTTP ${resp.status}`);
    return ServiceSchema.parse(await resp.json());
  }

  /** Conditional on the etag, and limited to `traffic`, so no new revision. "conflict": the service changed. */
  async patchTraffic(p: PreviewProduct, part: string, service: RunService, traffic: readonly RunTraffic[]): Promise<"ok" | "conflict"> {
    const resp = await this.call(`${GcpApi.serviceUrl(p, part)}?updateMask=traffic`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...service, traffic }),
    });
    if (resp.status === 409 || resp.status === 412) return "conflict";
    if (!resp.ok) throw new Error(`Cloud Run update: HTTP ${resp.status}`);
    return "ok";
  }

  private static configUrl(project: string) {
    return `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;
  }

  /** The quota project: this identity's home project isn't the dev project, whose API it's calling. */
  private static quota(project: string) {
    return { "x-goog-user-project": project };
  }

  async readDomains(project: string): Promise<string[]> {
    const resp = await this.call(GcpApi.configUrl(project), { headers: GcpApi.quota(project) });
    if (!resp.ok) throw new Error(`Identity Platform read: HTTP ${resp.status}`);
    return AuthConfigSchema.parse(await resp.json()).authorizedDomains;
  }

  async patchDomains(project: string, domains: readonly string[]): Promise<void> {
    const resp = await this.call(`${GcpApi.configUrl(project)}?updateMask=authorizedDomains`, {
      method: "PATCH",
      headers: { ...GcpApi.quota(project), "content-type": "application/json" },
      body: JSON.stringify({ authorizedDomains: domains }),
    });
    if (!resp.ok) throw new Error(`Identity Platform update: HTTP ${resp.status}`);
  }
}

// ---- Review state and holds, as found ----

const LEDGER_NAME = /^reviews\/([^/]+\/[^/]+)\/pr-([1-9][0-9]{0,9})\.json$/;
const CLAIM_NAME = /^reviews\/([^/]+\/[^/]+)\/pr-([1-9][0-9]{0,9})\/([0-9a-f]{40})\.claim\.json$/;

export interface ReviewStateEntry {
  repo: string;
  pr: number;
  hasLedger: boolean;
  shas: string[];
}

/** Groups `reviews/` by PR. Any name that isn't exactly a ledger or a claim of a slug-named repo is ignored. */
export function groupReviewObjects(names: readonly string[]): ReviewStateEntry[] {
  const prs = new Map<string, ReviewStateEntry>();
  const entry = (repo: string, pr: number) => {
    const key = `${repo}#${pr}`;
    const cur = prs.get(key) ?? { repo, pr, hasLedger: false, shas: [] };
    prs.set(key, cur);
    return cur;
  };
  for (const name of names) {
    const claim = CLAIM_NAME.exec(name);
    const m = claim ?? LEDGER_NAME.exec(name);
    if (!m || !isRepoSlug(m[1]!) || m[1] !== m[1]!.toLowerCase()) continue;
    const e = entry(m[1]!, Number(m[2]));
    if (claim) e.shas.push(claim[3]!);
    else e.hasLedger = true;
  }
  return [...prs.values()];
}

const SpendHoldsSchema = z.object({ reservations: z.array(z.object({ runId: z.string(), usd: z.number(), at: z.string(), kind: z.string().optional() })).default([]) });

interface PlannedTags {
  product: PreviewProduct;
  part: string;
  tags: Map<string, number>;
}
interface PlannedReview {
  entry: ReviewStateEntry;
  /** GitHub's casing, for the spend record. */
  repo: string;
  release: { runId: string; usd: number }[];
  purge: boolean;
}

export interface CleanupDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  gcpToken?: AccessToken;
  now?: () => Date;
  /** The stack config's text. Default: STACK_CONFIG_PATH in the checkout. */
  readStack?: () => Promise<string>;
}

export interface CleanupResult {
  report: CleanupReport;
  markdown: string;
}

/**
 * The whole job. It applies only with CLEANUP_APPLY exactly `true` and CLEANUP_DRY_RUN not `1`; otherwise it plans,
 * prints and writes nothing. Failures to read one thing are reported and don't stop the rest; they fail the job.
 *
 * Env: GITHUB_TOKEN (reads PRs; a private repo it can't read is kept and reported), CLEANUP_APPLY, CLEANUP_DRY_RUN.
 */
export async function cleanupStep(deps: CleanupDeps): Promise<CleanupResult> {
  const { env, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apply = env.CLEANUP_APPLY === "true" && env.CLEANUP_DRY_RUN !== "1";
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  if (apply && !env.GITHUB_TOKEN) throw new CleanupError("cleanup: GITHUB_TOKEN is not set");

  const token = reusedToken(deps.gcpToken ?? gcloudAccessToken);
  const store = new ObjectStore(token, fetchImpl);
  const control = new ControlPlane(store, () => now);
  const api = new GcpApi(token, fetchImpl);
  const gh = new GitHubClient(env.GITHUB_TOKEN, fetchImpl);

  let products: PreviewProduct[];
  try {
    products = parseStackProducts(await (deps.readStack ?? (() => readFile(STACK_CONFIG_PATH, "utf8")))());
  } catch {
    throw new CleanupError("cleanup: the stack config couldn't be read");
  }

  const failures: string[] = [];
  const kept: Kept[] = [];
  const attempt = async (description: string, what: () => Promise<void>) => {
    try {
      await what();
    } catch (e) {
      if (e instanceof GcpTokenError && failures.includes(e.message)) return;
      failures.push(failureText(description, e));
    }
  };

  // One answer per number per run: a tag and a domain of one PR can't be judged differently.
  const answers = new Map<string, Promise<PrTruth>>();
  const truthOf = (repo: string, pr: number) => {
    const key = `${repo.toLowerCase()}#${pr}`;
    const known = answers.get(key);
    if (known) return known;
    const asked = readPrTruth(gh, repo, pr, nowMs);
    answers.set(key, asked);
    return asked;
  };
  const judge = async (what: Kept["what"], repo: string, pr: number): Promise<boolean> => {
    const truth = await truthOf(repo, pr);
    const verdict = previewVerdict(truth, nowMs);
    if (verdict === "orphan") return true;
    if (verdict === "unknown" && truth.kind === "unknown") kept.push({ what, pr, why: truth.why });
    else if (verdict === "closed-recently") kept.push({ what, pr, why: "closed under an hour ago" });
    return false;
  };

  // ── Plan: only reads from here to the cap ──────────────────────────────────────────────────────
  const plannedTags: PlannedTags[] = [];
  const plannedDomains = new Map<string, Map<string, number>>();
  for (const product of products) {
    for (const part of product.parts) {
      await attempt("reading a preview service", async () => {
        const service = await api.readService(product, part);
        const tags = new Map<string, number>();
        for (const entry of service.traffic) {
          const pr = entry.tag === undefined ? null : prFromTag(entry.tag);
          if (pr === null) continue;
          if (!isRemovableTagEntry(entry)) {
            kept.push({ what: "preview tag", pr, why: "it carries traffic or isn't a pinned revision" });
            continue;
          }
          if (await judge("preview tag", product.repo, pr)) tags.set(entry.tag!, pr);
        }
        if (tags.size > 0) plannedTags.push({ product, part, tags });
      });
    }
    await attempt("reading the authorized domains", async () => {
      const domains = await api.readDomains(product.devProject);
      const orphans = plannedDomains.get(product.devProject) ?? new Map<string, number>();
      for (const domain of domains) {
        for (const part of product.parts) {
          const pr = prFromDomain(domain, product.product, part);
          if (pr !== null && (await judge("authorized domain", product.repo, pr))) orphans.set(domain, pr);
        }
      }
      if (orphans.size > 0) plannedDomains.set(product.devProject, orphans);
    });
  }

  const plannedReviews: PlannedReview[] = [];
  await attempt("reading review state", async () => {
    const entries = groupReviewObjects(await store.list(CONTROL_BUCKET, "reviews/"));
    await mapLimited(entries, READ_CONCURRENCY, async (entry) => {
      const truth = await truthOf(entry.repo, entry.pr);
      let ledger: ReviewLedger | null | "corrupt" = null;
      if (entry.hasLedger) {
        const obj = await store.read(CONTROL_BUCKET, `reviews/${entry.repo}/pr-${entry.pr}.json`);
        if (obj) {
          const parsed = safeLedger(obj.body);
          ledger = parsed ?? "corrupt";
        }
      }
      const plan = planReviewPr(truth, ledger, nowMs);
      if (plan.kept) kept.push({ what: "review state", pr: entry.pr, why: plan.kept });
      if (truth.kind === "closed" && (plan.purge || plan.release.length > 0)) {
        const reservations = ledger !== null && ledger !== "corrupt" ? ledger.reservations : [];
        const release = plan.release.map((runId) => ({ runId, usd: reservations.find((r) => r.runId === runId)?.reservedUsd ?? 0 }));
        plannedReviews.push({ entry, repo: truth.repo, release, purge: plan.purge });
      }
    });
  });

  const plannedHolds: { object: string; runId: string; usd: number }[] = [];
  await attempt("reading the spend records", async () => {
    const { from, to } = spendWindow(now);
    const names = (await store.list(CONTROL_BUCKET, "spend/")).filter((n) => {
      const key = parseSpendName(n);
      return key !== null && key.day >= from && key.day <= to;
    });
    await mapLimited(names, READ_CONCURRENCY, async (name) => {
      const obj = await store.read(CONTROL_BUCKET, name);
      const parsed = obj ? SpendHoldsSchema.safeParse(safeJson(obj.body)) : undefined;
      if (!parsed?.success) return; // A corrupt record is the watcher's to report.
      for (const r of parsed.data.reservations) {
        if (r.kind === "dispatch" && dispatchHoldReleasable(r.at, nowMs)) plannedHolds.push({ object: name, runId: r.runId, usd: r.usd });
      }
    });
  });

  const tagPrs = plannedTags.flatMap((t) => [...t.tags.values()]);
  const domainPrs = [...plannedDomains.values()].flatMap((m) => [...m.values()]);
  const purges = plannedReviews.filter((r) => r.purge);
  const releases = plannedReviews.flatMap((r) => r.release.map((x) => ({ pr: r.entry.pr, usd: x.usd })));
  const planned = tagPrs.length + domainPrs.length + purges.length + releases.length + plannedHolds.length;
  const capped = overCap(planned);

  const report: CleanupReport = {
    mode: apply && !capped ? "apply" : "dry-run",
    overCap: capped,
    planned,
    tags: tagPrs,
    domains: domainPrs,
    reviewState: purges.map((r) => r.entry.pr),
    reservations: releases,
    dispatchHolds: plannedHolds.map((h) => ({ usd: h.usd })),
    kept,
    failures,
  };

  // ── Apply ───────────────────────────────────────────────────────────────────────────────────────
  if (report.mode === "apply") {
    report.tags = [];
    report.domains = [];
    report.reviewState = [];
    report.reservations = [];
    report.dispatchHolds = [];

    for (const { product, part, tags } of plannedTags) {
      await attempt("removing preview tags", async () => {
        const removed = await removeTags(api, product, part, new Set(tags.keys()));
        if (removed === null) failures.push("removing preview tags: the service kept changing; left for the next run");
        else for (const tag of removed) report.tags.push(tags.get(tag)!);
      });
    }
    for (const [project, orphans] of plannedDomains) {
      await attempt("removing authorized domains", async () => {
        // No etag on this API, so re-read immediately before the write: a concurrent add in the moment since the
        // plan's read is kept, and only the domains judged orphans are taken out of the list as it is now.
        const current = await api.readDomains(project);
        const next = current.filter((d) => !orphans.has(d));
        if (next.length === current.length) return;
        await api.patchDomains(project, next);
        for (const domain of current) if (orphans.has(domain)) report.domains.push(orphans.get(domain)!);
      });
    }
    for (const review of plannedReviews) {
      const pr = { repo: review.repo, pr: review.entry.pr };
      for (const { runId, usd } of review.release) {
        await attempt("releasing a reservation", async () => {
          if (await control.releaseStaleReservation(pr, runId)) report.reservations.push({ pr: pr.pr, usd });
        });
      }
      if (!review.purge) continue;
      await attempt("deleting review state", async () => {
        const outcome = await control.deleteReviewState(pr, review.entry.shas);
        if (outcome === "deleted") report.reviewState.push(pr.pr);
        else kept.push({ what: "review state", pr: pr.pr, why: outcome === "held" ? "it has an open reservation" : outcome === "corrupt" ? "its ledger is corrupt" : "it changed during this run" });
      });
    }
    for (const hold of plannedHolds) {
      await attempt("releasing a dead session's hold", async () => {
        if (await control.releaseDispatchHold(hold.object, hold.runId)) report.dispatchHolds.push({ usd: hold.usd });
      });
    }
  }

  const markdown = renderCleanupReport(report);
  log(`cleanup: ${report.mode}: ${report.tags.length} tags, ${report.domains.length} domains, ${report.reviewState.length} PRs' review state, ${report.reservations.length + report.dispatchHolds.length} holds released, ${kept.length} kept, ${failures.length} failures`);
  return { report, markdown };
}

/** Takes these tags off the service as it is now, by etag, retrying when it changed. Null: it kept changing. */
async function removeTags(api: GcpApi, product: PreviewProduct, part: string, tags: ReadonlySet<string>): Promise<string[] | null> {
  for (let i = 0; i < MAX_TRAFFIC_ATTEMPTS; i++) {
    const service = await api.readService(product, part);
    const next = trafficWithout(service.traffic, tags);
    const removed = service.traffic.filter((e) => !next.includes(e)).map((e) => e.tag!);
    if (removed.length === 0) return [];
    if ((await api.patchTraffic(product, part, service, next)) === "ok") return removed;
  }
  return null;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function safeLedger(body: string): ReviewLedger | null {
  const parsed = ReviewLedgerSchema.safeParse(safeJson(body));
  return parsed.success ? parsed.data : null;
}
