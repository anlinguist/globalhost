// `globalhost metrics`, the nightly job (P1-13, ADR-0020): read the buckets and GitHub, aggregate (metrics.ts),
// write metrics/<day>.json, edit the rolling issue. The caller fails the job when the watcher has findings.
//
// Actions logs in this repo are public. Object names and API paths can name a private repo, so nothing that holds
// one is logged or thrown from here: errors are MetricsError, with fixed text and an HTTP status.
import { z } from "zod";
import { CONTROL_BUCKET, ObjectStore, RUNS_BUCKET, gcloudAccessToken, isRepoSlug, type AccessToken } from "./gcp.js";
import { GitHubClient, GitHubError } from "./github.js";
import {
  aggregateMetrics,
  budgetCycle,
  lastCompleteDay,
  parseLedgers,
  parseRuns,
  parseSpend,
  parseSpendName,
  REVIEW_LEDGER_PATH,
  staleLedgerHolds,
  renderMetricsMarkdown,
  spendWindow,
  type MetricsReport,
  type RepoInfo,
  type StoredObject,
} from "./metrics.js";

export const METRICS_ISSUE_TITLE = "Factory metrics";
export const METRICS_LABEL = "factory:metrics";
/** Who GITHUB_TOKEN writes as. The rolling issue is only ever one this account opened. */
export const ACTIONS_BOT_LOGIN = "github-actions[bot]";

export const READ_CONCURRENCY = 8;
const MAX_PULL_PAGES = 20;
const TOKEN_REUSE_MS = 30 * 60_000;
const FACTORY_BRANCH = /^factory\/issue-[1-9][0-9]*$/;

/** A failure whose message is safe for a public log. */
export class MetricsError extends Error {}

/** Minting a GCP token failed. Its own type because the cause isn't the object store, and the message stays fixed. */
export class GcpTokenError extends Error {
  constructor() {
    super("getting a GCP token failed");
    this.name = "GcpTokenError";
  }
}

/** Only the status survives from a failure: the rest of the message can hold an object name or API path. */
export const httpStatus = (e: unknown) => /HTTP \d+/.exec(e instanceof Error ? e.message : "")?.[0] ?? "no HTTP status";

/** A failure as fixed text, safe for a public log. A token failure reads as one, whatever was being attempted. */
export const failureText = (description: string, e: unknown) => (e instanceof GcpTokenError ? e.message : `${description} failed (${httpStatus(e)})`);

async function safely<T>(description: string, what: () => Promise<T>): Promise<T> {
  try {
    return await what();
  } catch (e) {
    throw new MetricsError(`metrics: ${failureText(description, e)}`);
  }
}

export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** An object deleted between listing and reading (the 30-day lifecycle) just isn't there any more. */
export async function readAll(store: ObjectStore, bucket: string, names: readonly string[]): Promise<StoredObject[]> {
  const read = await mapLimited(names, READ_CONCURRENCY, async (name) => {
    const obj = await store.read(bucket, name);
    return obj ? { name, body: obj.body } : null;
  });
  return read.filter((o): o is StoredObject => o !== null);
}

/** Every run.json in the runs bucket, however old: an earlier turn is the baseline of a later one. */
export async function readRunRecords(store: ObjectStore): Promise<StoredObject[]> {
  return safely("reading the runs bucket", async () => {
    const names = (await store.list(RUNS_BUCKET, "")).filter((n) => n === "run.json" || n.endsWith("/run.json"));
    return readAll(store, RUNS_BUCKET, names);
  });
}

/** Every PR review ledger, for the holds they carry. Claims aren't read: they hold no spend. */
export async function readReviewLedgers(store: ObjectStore): Promise<StoredObject[]> {
  return safely("reading the review ledgers", async () => {
    const names = (await store.list(CONTROL_BUCKET, "reviews/")).filter((n) => REVIEW_LEDGER_PATH.test(n));
    return readAll(store, CONTROL_BUCKET, names);
  });
}

/** The spend records of the days the report needs. A malformed name is always kept, so it gets reported. */
export async function readSpendRecords(store: ObjectStore, now: Date): Promise<StoredObject[]> {
  const { from, to } = spendWindow(now);
  return safely("reading the control bucket", async () => {
    const names = (await store.list(CONTROL_BUCKET, "spend/")).filter((n) => {
      const key = parseSpendName(n);
      return key === null || (key.day >= from && key.day <= to);
    });
    return readAll(store, CONTROL_BUCKET, names);
  });
}

const RepoSchema = z.object({ private: z.boolean(), visibility: z.string().optional() });

const ClosedPullSchema = z.array(
  z.object({
    merged_at: z.string().nullable(),
    updated_at: z.string(),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  }),
);

/** The UTC days this repo's own `factory/issue-<n>` branches merged since `since`. Fork PRs don't count. */
export async function mergedFactoryPrDays(gh: GitHubClient, repo: string, since: string): Promise<string[] | null> {
  const days: string[] = [];
  for (let page = 1; page <= MAX_PULL_PAGES; page++) {
    const batch = await gh.request("GET", `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, undefined, ClosedPullSchema);
    for (const pull of batch) {
      if (pull.merged_at === null || !FACTORY_BRANCH.test(pull.head.ref) || pull.head.repo?.full_name.toLowerCase() !== repo) continue;
      const ms = Date.parse(pull.merged_at);
      if (!Number.isNaN(ms)) days.push(new Date(ms).toISOString().slice(0, 10));
    }
    // Sorted by last update, and a merge is an update, so nothing further back can have merged in the window.
    const oldest = batch.at(-1)?.updated_at;
    if (batch.length < 100 || oldest === undefined || oldest.slice(0, 10) < since) return days;
  }
  return null;
}

/**
 * Whether each repo is confirmed public, and its merged factory PRs. Anything short of a clear "public" (private,
 * 404, 403, rate limit, an unexpected body) makes it `other`, and the job carries on: a repo the token can't read
 * is normal. A public repo's PR list failing leaves its merge count unknown.
 */
export async function readRepoInfo(gh: GitHubClient, repos: readonly string[], since: string): Promise<Map<string, RepoInfo>> {
  const info = new Map<string, RepoInfo>();
  for (const repo of repos) {
    const r = await gh.request("GET", `/repos/${repo}`, undefined, RepoSchema).catch(() => null);
    const isPublic = r !== null && !r.private && (r.visibility === undefined || r.visibility === "public");
    const mergedDays = isPublic ? await mergedFactoryPrDays(gh, repo, since).catch(() => null) : null;
    info.set(repo, { public: isPublic, mergedDays });
  }
  return info;
}

const IssueListSchema = z.array(
  z.object({
    number: z.number().int(),
    user: z.object({ login: z.string(), type: z.string() }).nullable(),
    pull_request: z.unknown().optional(),
  }),
);
const CreatedIssueSchema = z.object({ number: z.number().int(), labels: z.array(z.object({ name: z.string() })).default([]) });

/**
 * Edits the rolling issue, creating it if there is none. Matched by label and author on the client side: anyone can
 * open an issue with that title, but only a bot-authored one with the label is ours. Reopens it if it was closed.
 */
export async function publishMetricsIssue(gh: GitHubClient, repo: string, body: string): Promise<number> {
  const listed = await gh.request(
    "GET",
    `/repos/${repo}/issues?labels=${encodeURIComponent(METRICS_LABEL)}&state=all&sort=created&direction=asc&per_page=100`,
    undefined,
    IssueListSchema,
  );
  const existing = listed.find((i) => i.pull_request === undefined && i.user?.login === ACTIONS_BOT_LOGIN && i.user.type === "Bot");
  if (existing) {
    await gh.request("PATCH", `/repos/${repo}/issues/${existing.number}`, { body, state: "open" });
    return existing.number;
  }
  try {
    await gh.request("POST", `/repos/${repo}/labels`, { name: METRICS_LABEL, color: "5319e7", description: "The rolling factory metrics issue (nightly.yml)" });
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422)) throw e; // 422: it already exists
  }
  const created = await gh.request("POST", `/repos/${repo}/issues`, { title: METRICS_ISSUE_TITLE, body, labels: [METRICS_LABEL] }, CreatedIssueSchema);
  // GitHub can drop labels on create without saying so; without the label, tomorrow's run would open another issue.
  if (!created.labels.some((l) => l.name === METRICS_LABEL)) {
    await gh.request("POST", `/repos/${repo}/issues/${created.number}/labels`, { labels: [METRICS_LABEL] });
  }
  return created.number;
}

/** One token for the whole job, so reading hundreds of objects doesn't spawn gcloud hundreds of times. */
export function reusedToken(mint: AccessToken, now: () => number = Date.now): AccessToken {
  let held: { token: string; at: number } | undefined;
  return async () => {
    if (!held || now() - held.at > TOKEN_REUSE_MS) {
      try {
        held = { token: await mint(), at: now() };
      } catch {
        throw new GcpTokenError(); // gcloud's own message can name the account or a path
      }
    }
    return held.token;
  };
}

export interface MetricsDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Standard output, for METRICS_DRY_RUN. */
  out?: (text: string) => void;
  fetchImpl?: typeof fetch;
  gcpToken?: AccessToken;
  now?: () => Date;
}

export interface MetricsResult {
  report: MetricsReport;
  markdown: string;
}

/**
 * The whole job. Throws MetricsError when it can't read or can't publish. Findings aren't an error here: the report
 * is published either way, and the caller fails the job on them, so GitHub emails the owner.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY (the factory repo, for the issue). METRICS_DRY_RUN=1 writes nothing and prints
 * the report instead; it needs no write access, so the owner can run it locally.
 */
export async function metricsStep(deps: MetricsDeps): Promise<MetricsResult> {
  const { env, log, fetchImpl } = deps;
  const dryRun = env.METRICS_DRY_RUN === "1";
  const factoryRepo = env.GITHUB_REPOSITORY ?? "";
  if (!dryRun && !isRepoSlug(factoryRepo)) throw new MetricsError("metrics: GITHUB_REPOSITORY must be owner/name");
  if (!dryRun && !env.GITHUB_TOKEN) throw new MetricsError("metrics: GITHUB_TOKEN is not set");

  const now = (deps.now ?? (() => new Date()))();
  const store = new ObjectStore(reusedToken(deps.gcpToken ?? gcloudAccessToken), fetchImpl);
  const gh = new GitHubClient(env.GITHUB_TOKEN, fetchImpl);

  const runs = parseRuns(await readRunRecords(store));
  const spend = parseSpend(await readSpendRecords(store, now));
  const ledgers = parseLedgers(await readReviewLedgers(store));
  const seen = [
    ...new Set([
      ...runs.events.map((e) => e.repo),
      ...runs.unrecognized.flatMap((u) => u.repo ?? []),
      ...spend.rows.map((r) => r.repo),
      ...spend.corrupt.flatMap((c) => c.repo ?? []),
      ...ledgers.holds.map((h) => h.repo),
      ...ledgers.corrupt.map((c) => c.repo),
    ]),
  ].sort();
  const repos = await readRepoInfo(gh, seen, budgetCycle(lastCompleteDay(now)).start);

  const report = aggregateMetrics({ now, runs, spend, repos, ledgers });
  const markdown = renderMetricsMarkdown(report);
  log(`metrics: ${report.day}: ${report.cycle.metrics.totalRuns} runs in the cycle, ${report.findings.length} findings`);

  if (dryRun) {
    deps.out?.(markdown);
    return { report, markdown };
  }

  // Each is attempted whatever happens to the other: one working output is better than none.
  const failures: string[] = [];
  const attempt = async (what: () => Promise<unknown>, description: string) => {
    try {
      await what();
    } catch (e) {
      failures.push(failureText(description, e));
    }
  };
  await attempt(async () => {
    await store.write(CONTROL_BUCKET, `metrics/${report.day}.json`, `${JSON.stringify(report, null, 2)}\n`);
    // Where the problems are, for the owner: names can name a private repo, so they stay in the private bucket.
    const problems = {
      unrecognizedRuns: runs.unrecognized.map((u) => u.name),
      corruptSpend: spend.corrupt.map((c) => c.name),
      corruptLedgers: ledgers.corrupt.map((c) => c.name),
      staleLedgerHolds: staleLedgerHolds(ledgers, now).map((h) => ({ object: h.name, runId: h.runId })),
    };
    if (Object.values(problems).some((list) => list.length > 0)) {
      await store.write(CONTROL_BUCKET, `metrics/${report.day}.problems.json`, `${JSON.stringify(problems, null, 2)}\n`);
    }
  }, `writing gs://${CONTROL_BUCKET}/metrics/${report.day}.json`);
  await attempt(() => publishMetricsIssue(gh, factoryRepo, markdown), "updating the metrics issue");
  if (failures.length > 0) throw new MetricsError(`metrics: ${failures.join("; ")}`);
  return { report, markdown };
}
