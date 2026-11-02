// `globalhost dispatch observe` (PLAN P1-12): runs after a merge to the default branch. It watches each
// part's `cloud-build-trigger` release for the merge commit, reports the outcome on the merged PR(s) and,
// for factory PRs, on the issue, and closes the issue once the deploy succeeded.
//
// Runs in the product repo's release-observe workflow on the default branch with a GITHUB_TOKEN that can
// write issues and PRs and a GCP identity that can only read Cloud Build. The repo may be public, so
// comments carry only the build id, its state and the console URL: never statusDetail, logs or substitutions.
import { ADAPTER_ID as CLOUD_BUILD_TRIGGER, STATUS_MAP, createCloudBuildTriggerAdapter } from "@globalhost/adapter-cloud-build-trigger";
import type { DeployAdapter, FactoryConfig, ReleaseHandle, ReleaseStatus, Registry } from "@globalhost/core";
import { z } from "zod";
import { loadConfig, type Env } from "./dispatch.js";
import { gcloudAccessToken, type AccessToken } from "./gcp.js";
import { GitHubClient, listComments } from "./github.js";
import { LABELS, removeLabel } from "./publish.js";

/** The identity behind a workflow's GITHUB_TOKEN; only its comments are edited. */
export const ACTIONS_BOT = "github-actions[bot]";
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 60;
export const DEFAULT_POLL_SECONDS = 20;
const CONSOLE_PREFIX = "https://console.cloud.google.com/";
const SHA = /^[0-9a-f]{40}$/;
const RepoSlug = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
const FACTORY_BRANCH = /^factory\/issue-([1-9][0-9]{0,6})$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** The adapter's detail starts `Cloud Build <id>: <STATUS>`; only those two tokens are read from it. */
const DETAIL_HEAD = /^Cloud Build ([A-Za-z0-9][A-Za-z0-9-]{0,63}): ([A-Z_]{1,32})(?=$| )/;

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

export type PartOutcome = "succeeded" | "failed" | "cancelled" | "not-observed";

export interface PartResult {
  /** Part name, with the target index when a part has several cloud-build-trigger targets. */
  label: string;
  outcome: PartOutcome;
  buildId?: string;
  /** The provider's raw state (e.g. FAILURE, TIMEOUT); only one of the adapter's known states. */
  providerState?: string;
  url?: string;
}

export interface ObserveResult {
  outcome: "no-release" | "succeeded" | "failed";
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

/** Build id and raw state from the adapter's status, never anything after them. */
function buildInfo(handle: ReleaseHandle, status: ReleaseStatus): { buildId?: string; providerState?: string } {
  const head = DETAIL_HEAD.exec(status.detail);
  const fromHandle = handle.data.buildId;
  const buildId = fromHandle && BUILD_ID.test(fromHandle) ? fromHandle : head?.[1];
  const raw = head?.[2];
  const providerState = raw && (Object.hasOwn(STATUS_MAP, raw) || raw === "STATUS_UNKNOWN") ? raw : undefined;
  return { buildId, providerState };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

interface Target {
  label: string;
  adapter: DeployAdapter;
  handle: ReleaseHandle;
  result: PartResult;
}

export function statusLine(r: PartResult, sha: string, minutes: number, prefix: boolean): string[] {
  const p = prefix ? `**${r.label}:** ` : "";
  const id = r.buildId ? `\`${r.buildId}\`` : "(unknown id)";
  const url = consoleUrl(r.url);
  switch (r.outcome) {
    case "succeeded":
      return [`${p}Deployed to prod via Cloud Build ${id} ✅`, ...(url ? [`[Build details](${url})`] : [])];
    case "failed":
      return [`${p}❌ Cloud Build ${id} failed (${r.providerState ?? "FAILURE"})`, ...(url ? [`[Build log](${url})`] : [])];
    case "cancelled":
      return [`${p}⚠️ Cloud Build ${id} was cancelled`, ...(url ? [`[Build log](${url})`] : [])];
    case "not-observed":
      return [`${p}⏳ No prod build observed for ${sha.slice(0, 7)} within ${minutes} min`];
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
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
type PullForCommit = z.infer<typeof PullForCommit>;

/** The PR's issue when it's a factory PR: a `factory/issue-<n>` branch in this repo (not a fork's). */
export function factoryIssue(pr: PullForCommit, repo: string): number | undefined {
  if (pr.head.repo?.full_name !== repo) return undefined;
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

export async function observeStep(deps: ObserveDeps): Promise<ObserveResult> {
  const { env, log } = deps;
  const ev = (event: string, fields: Record<string, unknown> = {}) => log(JSON.stringify({ event: `observe.${event}`, ...fields }));
  const repo = RepoSlug.parse(need(env, "GITHUB_REPOSITORY"));
  const sha = need(env, "GITHUB_SHA");
  if (!SHA.test(sha)) throw new Error("GITHUB_SHA must be 40 lowercase hex characters");
  const minutes = intEnv(env, "OBSERVE_TIMEOUT_MINUTES", DEFAULT_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const pollMs = intEnv(env, "OBSERVE_POLL_SECONDS", DEFAULT_POLL_SECONDS, 300) * 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const gh = new GitHubClient(need(env, "GITHUB_TOKEN"), deps.fetchImpl);

  const config: FactoryConfig = await loadConfig(gh, repo, deps.registry);
  if (env.GITHUB_REF && env.GITHUB_REF !== `refs/heads/${config.git.defaultBranch}`) {
    throw new Error(`observe runs only on the default branch (${config.git.defaultBranch})`);
  }

  const gcpToken = deps.gcpToken ?? gcloudAccessToken;
  const makeAdapter = deps.adapterFactory ?? ((accessToken: AccessToken) => createCloudBuildTriggerAdapter({ accessToken, fetch: deps.fetchImpl }));
  const env0 = config.environments.prod ?? Object.values(config.environments)[0] ?? { gcpProject: "", region: "" };

  const targets: Target[] = [];
  for (const [part, p] of Object.entries(config.parts)) {
    const cbt = p.release.filter((t) => t.adapter === CLOUD_BUILD_TRIGGER);
    for (const [i, t] of cbt.entries()) {
      const label = cbt.length > 1 ? `${part}[${i}]` : part;
      const adapter = makeAdapter(gcpToken);
      const handle = await adapter.release({ product: config.product, part, sha, environment: env0 }, t.config);
      targets.push({ label, adapter, handle, result: { label, outcome: "not-observed" } });
    }
  }
  if (targets.length === 0) {
    ev("skip", { reason: `no part releases through ${CLOUD_BUILD_TRIGGER}` });
    return { outcome: "no-release", parts: [], pulls: [], closedIssues: [] };
  }

  // Poll every target until each reaches a terminal state or the deadline passes.
  const deadline = now() + minutes * 60_000;
  for (;;) {
    for (const t of targets) {
      if (TERMINAL.has(t.result.outcome)) continue;
      let status: ReleaseStatus;
      try {
        status = await t.adapter.status(t.handle);
      } catch (err) {
        // API errors carry only HTTP/API status codes; keep polling, they may be transient.
        ev("status_error", { part: t.label, error: (err as Error).message.slice(0, 200) });
        continue;
      }
      const { buildId, providerState } = buildInfo(t.handle, status);
      if (TERMINAL.has(status.state)) {
        t.result = { label: t.label, outcome: status.state as PartOutcome, buildId, providerState, url: consoleUrl(status.url) };
        ev("part", { part: t.label, outcome: t.result.outcome, build: buildId, state: providerState });
      }
    }
    if (targets.every((t) => TERMINAL.has(t.result.outcome))) break;
    if (now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  const parts = targets.map((t) => t.result);
  for (const r of parts) if (r.outcome === "not-observed") ev("part", { part: r.label, outcome: r.outcome });
  const succeeded = parts.every((r) => r.outcome === "succeeded");

  // The PRs this merge commit landed.
  const pulls = (await gh.request("GET", `/repos/${repo}/commits/${sha}/pulls?per_page=100`, undefined, z.array(PullForCommit))).filter(
    (pr) => pr.merged_at !== null && pr.merge_commit_sha === sha && pr.base.ref === config.git.defaultBranch,
  );
  if (pulls.length === 0) ev("no_pulls", { sha });

  const closedIssues: number[] = [];
  for (const pr of pulls) {
    const issue = factoryIssue(pr, repo);
    await upsertComment(gh, repo, pr.number, sha, releaseComment(parts, sha, minutes));
    ev("commented", { pr: pr.number });
    if (issue === undefined) continue;

    const info = await gh.request(
      "GET",
      `/repos/${repo}/issues/${issue}`,
      undefined,
      z.object({ number: z.number().int(), state: z.string(), pull_request: z.unknown().optional() }),
    );
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
      // The PR is merged and deployed, so the issue is no longer in review.
      await removeLabel(gh, repo, issue, LABELS.inReview);
      ev("closed", { issue });
    }
  }

  return { outcome: succeeded ? "succeeded" : "failed", parts, pulls: pulls.map((p) => p.number), closedIssues };
}
