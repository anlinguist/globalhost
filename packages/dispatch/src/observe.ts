// `globalhost dispatch observe` (PLAN P1-12): runs after a merge to the default branch. It watches each
// part's `cloud-build-trigger` release for the merge commit, reports the outcome on the merged PR(s) and,
// for factory PRs, on the issue, and closes the issue once the merged commit is confirmed live.
//
// A successful build is not a deploy (ADR-0019): after the build succeeds the adapter's verifyLive() must say the
// commit is what prod serves before anything says "Deployed" or closes an issue. Without a configured deploy target
// the build is reported as unverified, never as deployed.
//
// Runs in the product repo's globalhost-release.yml on the default branch with a GITHUB_TOKEN that can
// write issues and PRs and a GCP identity that can only read Cloud Build and Cloud Run services. The repo may be
// public, so comments carry only the build id, its state, fixed text and the console URL: never statusDetail, logs,
// substitutions, image names or revision names.
//
// Only the pushed head commit is observed: when one push lands several merges, only the PR(s) merged as
// the head commit are reported (GitHub runs one push workflow per push).
import {
  ADAPTER_ID as CLOUD_BUILD_TRIGGER,
  CloudBuildApiError,
  CloudRunApiError,
  STATUS_MAP,
  createCloudBuildTriggerAdapter,
} from "@globalhost/adapter-cloud-build-trigger";
import {
  GCP_PROJECT_PATTERN,
  REGION_PATTERN,
  type DeployAdapter,
  type FactoryConfig,
  type ReleaseHandle,
  type ReleaseNotLiveReason,
  type ReleaseStatus,
  type Registry,
} from "@globalhost/core";
import { z } from "zod";
import { loadConfig, type Env } from "./dispatch.js";
import { gcloudAccessToken, type AccessToken } from "./gcp.js";
import { GitHubClient, GitHubError, listComments } from "./github.js";
import { LABELS, removeLabel } from "./publish.js";

/** The identity behind a workflow's GITHUB_TOKEN; only its comments are edited. */
export const ACTIONS_BOT = "github-actions[bot]";
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 60;
export const DEFAULT_POLL_SECONDS = 20;
/** How long after a build succeeds the observer waits for prod to serve it (a rollout finishing). */
export const VERIFY_MINUTES = 5;
const CONSOLE_PREFIX = "https://console.cloud.google.com/";
const SHA = /^[0-9a-f]{40}$/;
const RepoSlug = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
const AppSlug = /^[a-z0-9][a-z0-9-]{0,33}$/;
const FACTORY_BRANCH = /^factory\/issue-([1-9][0-9]{0,6})$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** The adapter's detail starts `Cloud Build <id>: <STATUS>`; only those two tokens are read from it. */
const DETAIL_HEAD = /^Cloud Build ([A-Za-z0-9][A-Za-z0-9-]{0,63}): ([A-Z_]{1,32})(?=$| )/;
/** Cloud Build answers that won't change by waiting: no access, or no such trigger/build. */
const PERMANENT_HTTP = new Set([401, 403, 404]);

export const releaseMarker = (sha: string) => `<!-- globalhost-release:${sha} -->`;

export interface ObserveDeps {
  env: Env;
  registry: Registry;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  gcpToken?: AccessToken;
  /** Builds the adapter that observes a release target; default: the real `cloud-build-trigger` adapter. */
  adapterFactory?: (accessToken: AccessToken) => DeployAdapter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * succeeded: the build succeeded and the merged commit is confirmed live. unverified: the build succeeded but no
 * deploy target is configured, so nothing says it deployed. not-live: the build succeeded but prod doesn't serve the
 * commit (`reason`). verify-error: the deploy target couldn't be read. failed / cancelled: the build finished
 * that way. still-running: found but not finished by the deadline. no-build: no build for the commit by the
 * deadline. error: Cloud Build couldn't be read.
 */
export type PartOutcome =
  | "succeeded"
  | "unverified"
  | "not-live"
  | "verify-error"
  | "failed"
  | "cancelled"
  | "still-running"
  | "no-build"
  | "error";

export interface PartResult {
  /** Part name, with the target index when a part has several cloud-build-trigger targets. */
  label: string;
  outcome: PartOutcome;
  buildId?: string;
  /** The provider's raw state (e.g. FAILURE, WORKING); only one of the adapter's known states. */
  providerState?: string;
  url?: string;
  /** For "error" / "verify-error": the Cloud Build / Cloud Run HTTP status, when there was one. */
  httpStatus?: number;
  /** For "not-live": which check failed. */
  reason?: ReleaseNotLiveReason;
}

export interface ObserveResult {
  /**
   * "pending": nothing failed, but some build was still running at the deadline. "unverified": every build
   * succeeded, but some part has no deploy target to confirm it's live (issues stay open).
   */
  outcome: "no-release" | "succeeded" | "unverified" | "pending" | "failed";
  parts: PartResult[];
  pulls: number[];
  closedIssues: number[];
}

function intEnv(env: Env, name: string, dflt: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return Number(raw);
}

const need = (env: Env, name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** Only a console.cloud.google.com https link that can't break out of markdown link syntax. */
export function consoleUrl(raw: string | undefined): string | undefined {
  // Reject before parsing too: the URL parser silently drops newlines and tabs.
  if (!raw?.startsWith(CONSOLE_PREFIX) || raw.length > 2000 || /[\s()[\]<>"'`\\]/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.host !== "console.cloud.google.com" || url.username || url.password) return undefined;
  if (/[\s()[\]<>"'`\\]/.test(url.href)) return undefined;
  return url.href;
}

/**
 * The Console link built from the project ID, region and build ID. Cloud Build's own logUrl names the project by
 * number, which is kept out of public repos; the project ID is already public in factory.yaml.
 */
export function buildLink(handle: ReleaseHandle, buildId: string | undefined): string | undefined {
  const { project, region } = handle.data as { project?: unknown; region?: unknown };
  if (!buildId || !BUILD_ID.test(buildId) || typeof project !== "string" || typeof region !== "string") return undefined;
  if (!GCP_PROJECT_PATTERN.test(project) || !(region === "global" || REGION_PATTERN.test(region))) return undefined;
  const path = region === "global" ? `cloud-build/builds/${buildId}` : `cloud-build/builds;region=${region}/${buildId}`;
  return consoleUrl(`${CONSOLE_PREFIX}${path}?project=${project}`);
}

/** Build id and raw state from the adapter's status, never anything after them. */
function buildInfo(handle: ReleaseHandle, status: ReleaseStatus): { buildId?: string; providerState?: string } {
  const head = DETAIL_HEAD.exec(status.detail);
  const fromHandle = handle.data.buildId;
  const buildId = fromHandle && BUILD_ID.test(fromHandle) ? fromHandle : head?.[1];
  const raw = head?.[2];
  const providerState = raw && (Object.hasOwn(STATUS_MAP, raw) || raw === "STATUS_UNKNOWN") ? raw : undefined;
  return { buildId, providerState };
}

const FINISHED = new Set<PartOutcome>(["succeeded", "unverified", "not-live", "verify-error", "failed", "cancelled", "error"]);
const FAILED = new Set<PartOutcome>(["not-live", "verify-error", "failed", "cancelled", "no-build", "error"]);
const TERMINAL_STATE = new Set(["failed", "cancelled"]);

/** Fixed text per failed check; nothing from the API reaches a comment. */
export const NOT_LIVE_TEXT: Readonly<Record<ReleaseNotLiveReason, string>> = {
  "no-artifact": "the build pushed no images (nothing under `images:` in its build config), so it deployed nothing this check can see",
  "not-updated": "the Cloud Run service isn't serving an image built from this commit",
  "split-traffic": "the Cloud Run service's traffic isn't 100% on one revision",
  "not-ready": "the Cloud Run revision serving traffic isn't ready",
};

interface Target {
  label: string;
  part: string;
  config: unknown;
  adapter: DeployAdapter;
  handle?: ReleaseHandle;
  result: PartResult;
  /** Set once the build succeeded: until when to wait for prod to serve it. */
  verifyUntil?: number;
  /** The last verify attempt's failure, reported if the wait runs out. */
  lastVerify?: { reason: ReleaseNotLiveReason } | { httpStatus?: number };
}

export function statusLine(r: PartResult, sha: string, minutes: number, prefix: boolean): string[] {
  const p = prefix ? `**${r.label}:** ` : "";
  const id = r.buildId ? `\`${r.buildId}\`` : "(unknown id)";
  const url = consoleUrl(r.url);
  const link = (text: string) => (url ? [`[${text}](${url})`] : []);
  switch (r.outcome) {
    case "succeeded":
      return [`${p}Deployed to prod via Cloud Build ${id} ✅`, ...link("Build details")];
    case "unverified":
      return [`${p}Cloud Build ${id} succeeded, but deployment can't be verified (no deploy target configured).`, ...link("Build details")];
    case "not-live":
      return [`${p}❌ Cloud Build ${id} succeeded, but the merged commit isn't live: ${NOT_LIVE_TEXT[r.reason ?? "not-updated"]}.`, ...link("Build details")];
    case "verify-error":
      return [`${p}⚠️ Cloud Build ${id} succeeded, but Cloud Run couldn't be read to confirm the deploy${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}.`];
    case "failed":
      return [`${p}❌ Cloud Build ${id} failed (${r.providerState ?? "FAILURE"})`, ...link("Build log")];
    case "cancelled":
      return [`${p}⚠️ Cloud Build ${id} was cancelled`, ...link("Build log")];
    case "still-running":
      return [`${p}⏳ Cloud Build ${id} still ${r.providerState ?? "RUNNING"} after ${minutes} min.`, ...link("Build log")];
    case "no-build":
      return [`${p}⏳ No Cloud Build build for ${sha.slice(0, 7)} found within ${minutes} min; the trigger may not have fired.`];
    case "error":
      return [`⚠️ Couldn't read Cloud Build for ${r.label}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}`];
  }
}

export function releaseComment(parts: readonly PartResult[], sha: string, minutes: number, extra: string[] = []): string {
  const prefix = parts.length > 1;
  const lines = parts.flatMap((r) => statusLine(r, sha, minutes, prefix));
  return [...lines, ...extra, releaseMarker(sha)].join("\n");
}

const PullForCommit = z.object({
  number: z.number().int().positive(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
type PullForCommit = z.infer<typeof PullForCommit>;

/**
 * The PR's issue when it's a factory PR: opened by the factory App's bot from a `factory/issue-<n>` branch in
 * this repo. A fork's branch, or a factory branch whose PR someone opened by hand, doesn't count.
 */
export function factoryIssue(pr: PullForCommit, repo: string, appBot: string): number | undefined {
  if (pr.head.repo?.full_name !== repo) return undefined;
  if (pr.user?.type !== "Bot" || pr.user.login !== appBot) return undefined;
  const m = FACTORY_BRANCH.exec(pr.head.ref);
  return m ? Number(m[1]) : undefined;
}

/** Creates the sha's release comment, or updates our earlier one (re-runs don't duplicate). */
async function upsertComment(gh: GitHubClient, repo: string, issue: number, sha: string, body: string): Promise<void> {
  const mark = releaseMarker(sha);
  const existing = (await listComments(gh, repo, issue)).find((c) => c.user.type === "Bot" && c.user.login === ACTIONS_BOT && c.body?.includes(mark));
  if (existing) await gh.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  else await gh.request("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
}

/** Permanent Cloud Build / Cloud Run errors end a target; anything else (429, 5xx, network) is retried until the deadline. */
function classify(err: unknown): { permanent: boolean; httpStatus?: number } {
  if (err instanceof CloudBuildApiError || err instanceof CloudRunApiError) return { permanent: PERMANENT_HTTP.has(err.httpStatus), httpStatus: err.httpStatus };
  if (err instanceof TypeError) return { permanent: false }; // fetch: network failure
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { permanent: false }; // request timeout
  return { permanent: true };
}

export async function observeStep(deps: ObserveDeps): Promise<ObserveResult> {
  const { env, log } = deps;
  const ev = (event: string, fields: Record<string, unknown> = {}) => log(JSON.stringify({ event: `observe.${event}`, ...fields }));
  const repo = RepoSlug.parse(need(env, "GITHUB_REPOSITORY"));
  const sha = need(env, "GITHUB_SHA");
  if (!SHA.test(sha)) throw new Error("GITHUB_SHA must be 40 lowercase hex characters");
  const slug = need(env, "GLOBALHOST_APP_SLUG");
  if (!AppSlug.test(slug)) throw new Error("GLOBALHOST_APP_SLUG is not a GitHub App slug");
  const appBot = `${slug}[bot]`;
  const minutes = intEnv(env, "OBSERVE_TIMEOUT_MINUTES", DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const pollMs = intEnv(env, "OBSERVE_POLL_SECONDS", DEFAULT_POLL_SECONDS, 300) * 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const gh = new GitHubClient(need(env, "GITHUB_TOKEN"), deps.fetchImpl);

  // factory.yaml as of the commit being released, which is on the default branch (checked below and by
  // the PR filter); a later push can't change what this run observes.
  const config: FactoryConfig = await loadConfig(gh, repo, deps.registry, sha);
  if (need(env, "GITHUB_REF") !== `refs/heads/${config.git.defaultBranch}`) {
    throw new Error(`observe runs only on the default branch (${config.git.defaultBranch})`);
  }

  const gcpToken = deps.gcpToken ?? gcloudAccessToken;
  const makeAdapter = deps.adapterFactory ?? ((accessToken: AccessToken) => createCloudBuildTriggerAdapter({ accessToken, fetch: deps.fetchImpl }));
  // Only prod: the deploy target is verified in the prod project, never another environment's.
  const env0 = config.environments.prod ?? { gcpProject: "", region: "" };

  const targets: Target[] = [];
  for (const [part, p] of Object.entries(config.parts)) {
    const cbt = p.release.filter((t) => t.adapter === CLOUD_BUILD_TRIGGER);
    for (const [i, t] of cbt.entries()) {
      const label = cbt.length > 1 ? `${part}[${i}]` : part;
      targets.push({ label, part, config: t.config, adapter: makeAdapter(gcpToken), result: { label, outcome: "no-build" } });
      // A deploy target without a prod environment can't be checked; say why in the log (the comment says "no target").
      if (!config.environments.prod && (t.config as { cloudRun?: unknown } | undefined)?.cloudRun !== undefined) {
        ev("deploy_target_ignored", { part: label, reason: "cloudRun is set but environments.prod is missing" });
      }
    }
  }
  if (targets.length === 0) {
    ev("skip", { reason: `no part releases through ${CLOUD_BUILD_TRIGGER}` });
    return { outcome: "no-release", parts: [], pulls: [], closedIssues: [] };
  }

  const finish = (t: Target, over: Partial<PartResult> & { outcome: PartOutcome }) => {
    const { label, buildId, providerState, url } = t.result;
    t.result = { label, buildId, providerState, url, ...over };
    ev("part", { part: t.label, outcome: t.result.outcome, build: buildId, state: providerState, reason: t.result.reason });
  };

  // After the build succeeded: is the commit live? Fails closed: only `live` is success, an adapter without
  // verifyLive can't be, and an error reading the target ends as verify-error (permanent) or is retried until
  // the verify deadline.
  const verify = async (t: Target) => {
    if (!t.adapter.verifyLive) return finish(t, { outcome: "unverified" });
    try {
      const live = await t.adapter.verifyLive(t.handle!);
      if (live.state === "live") return finish(t, { outcome: "succeeded" });
      if (live.state === "unverifiable") return finish(t, { outcome: "unverified" });
      t.lastVerify = { reason: live.reason };
      ev("not_live", { part: t.label, reason: live.reason, final: live.final });
      if (live.final) return finish(t, { outcome: "not-live", reason: live.reason });
    } catch (err) {
      const { permanent, httpStatus } = classify(err);
      ev("verify_error", { part: t.label, permanent, error: (err as Error).message.slice(0, 200) });
      t.lastVerify = { httpStatus };
      if (permanent) return finish(t, { outcome: "verify-error", httpStatus });
    }
    // Out of time before another attempt: a build that never showed up live is not deployed.
    if (now() + pollMs > t.verifyUntil!) {
      const last = t.lastVerify;
      if (last && "reason" in last) finish(t, { outcome: "not-live", reason: last.reason });
      else finish(t, { outcome: "verify-error", httpStatus: last?.httpStatus });
    }
  };

  // Poll every target until each finishes or the deadline passes. release() only looks the build up (the
  // adapter is observe-only), so it's retried like status() until it works. A succeeded build then gets up to
  // VERIFY_MINUTES of its own for prod to serve it, even past the build deadline; builds aren't polled past it.
  const deadline = now() + minutes * 60_000;
  for (;;) {
    for (const t of targets) {
      if (FINISHED.has(t.result.outcome)) continue;
      if (t.verifyUntil !== undefined) {
        await verify(t);
        continue;
      }
      if (now() > deadline) continue;
      try {
        t.handle ??= await t.adapter.release({ product: config.product, part: t.part, sha, environment: env0 }, t.config);
        const status = await t.adapter.status(t.handle);
        const { buildId, providerState } = buildInfo(t.handle, status);
        const url = buildLink(t.handle, buildId);
        if (status.state === "succeeded") {
          t.result = { label: t.label, outcome: "still-running", buildId, providerState, url };
          ev("built", { part: t.label, build: buildId });
          t.verifyUntil = now() + VERIFY_MINUTES * 60_000;
          await verify(t);
        } else if (TERMINAL_STATE.has(status.state)) {
          t.result = { label: t.label, outcome: status.state as PartOutcome, buildId, providerState, url };
          ev("part", { part: t.label, outcome: t.result.outcome, build: buildId, state: providerState });
        } else if (buildId) {
          t.result = { label: t.label, outcome: "still-running", buildId, providerState, url };
        }
      } catch (err) {
        // API errors carry only HTTP/API status codes, never response bodies.
        const { permanent, httpStatus } = classify(err);
        ev("cloud_build_error", { part: t.label, permanent, error: (err as Error).message.slice(0, 200) });
        if (permanent) t.result = { label: t.label, outcome: "error", httpStatus };
      }
    }
    const open = targets.filter((t) => !FINISHED.has(t.result.outcome));
    if (open.length === 0) break;
    // Keep going while any open target still has time: a build until the build deadline, a verification until its
    // own deadline (verify() finishes a target whose time is up, so an open verification always has time left).
    if (open.every((t) => t.verifyUntil === undefined) && now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  const parts = targets.map((t) => t.result);
  for (const r of parts) if (!FINISHED.has(r.outcome)) ev("part", { part: r.label, outcome: r.outcome, build: r.buildId, state: r.providerState });
  const succeeded = parts.every((r) => r.outcome === "succeeded");
  const failed = parts.some((r) => FAILED.has(r.outcome));
  const pending = parts.some((r) => r.outcome === "still-running");

  // The PRs this merge commit landed.
  const pulls = (await gh.request("GET", `/repos/${repo}/commits/${sha}/pulls?per_page=100`, undefined, z.array(PullForCommit))).filter(
    (pr) => pr.merged_at !== null && pr.merge_commit_sha === sha && pr.base.ref === config.git.defaultBranch,
  );
  if (pulls.length === 0) ev("no_pulls", { sha });

  const closedIssues: number[] = [];
  for (const pr of pulls) {
    await upsertComment(gh, repo, pr.number, sha, releaseComment(parts, sha, minutes));
    ev("commented", { pr: pr.number });
    const issue = factoryIssue(pr, repo, appBot);
    if (issue === undefined) continue;

    let info;
    try {
      info = await gh.request(
        "GET",
        `/repos/${repo}/issues/${issue}`,
        undefined,
        z.object({ number: z.number().int(), state: z.string(), pull_request: z.unknown().optional() }),
      );
    } catch (err) {
      // Deleted or transferred: nothing to report on.
      if (!(err instanceof GitHubError && (err.status === 404 || err.status === 410))) throw err;
      ev("skip_issue", { pr: pr.number, issue, reason: `HTTP ${err.status}` });
      continue;
    }
    if (info.pull_request !== undefined) {
      ev("skip_issue", { pr: pr.number, issue, reason: "is a pull request" });
      continue;
    }
    await upsertComment(gh, repo, issue, sha, releaseComment(parts, sha, minutes, ["", `Merged in #${pr.number}.`]));
    if (succeeded) {
      if (info.state !== "closed") {
        await gh.request("PATCH", `/repos/${repo}/issues/${issue}`, { state: "closed", state_reason: "completed" });
        closedIssues.push(issue);
      }
      // The PR is merged and its commit confirmed live, so the issue is no longer in review.
      await removeLabel(gh, repo, issue, LABELS.inReview);
      ev("closed", { issue });
    }
  }

  const outcome = succeeded ? "succeeded" : failed ? "failed" : pending ? "pending" : "unverified";
  return { outcome, parts, pulls: pulls.map((p) => p.number), closedIssues };
}
