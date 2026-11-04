// The review steps of the installed review workflow (P2-01, shadow mode; the workflow itself is PR 5):
//   review-gate  read-only GITHUB_TOKEN: decides from the event (decideReview) whether the review job runs.
//   review       environment `globalhost-review`: re-decides with its own reads, then
//                claim (per SHA) → reserve → read diff, CI summary, screenshots → scan → startReview →
//                harness-stamped record → archive (create-only) → settle → complete claim → post.
// Reviews don't take a builder slot. Every exit after the claim settles through recordReviewRun, with the run's
// cost (or the per-run cap when a session may exist and its cost is unknown), so the PR ledger never loses
// spend. The review is posted only by the run that completed the claim, with a token that can write PR
// reviews, issues and labels but not contents.
import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_REVIEW_USD,
  overallVerdict,
  ReviewRecordSchema,
  scanDiff,
  shadowEntryFromRecord,
  type Finding,
  type ReviewOutput,
  type ReviewRecord,
  type ReviewStatus,
  type ScanHit,
} from "@globalhost/core";
import { DEFAULT_MODEL, REVIEW_OUTPUT_FILE } from "@globalhost/roles";
import {
  GitHubReader,
  REVIEW_SETTLE_MARGIN_MINUTES,
  ReviewNotStartedError,
  ReviewRunError,
  anthropicClient,
  createReviewBundle,
  federationIdsFromEnv,
  githubActionsIdentity,
  sdkApi,
  startReview,
  type ManagedAgentsApi,
  type ReviewBundle,
  type ReviewRun,
} from "@globalhost/runner";
import { githubIdEnv, loadConfig, type DispatchDeps, type Env } from "./dispatch.js";
import { ControlPlane, ObjectStore, RUNS_BUCKET, accessSecret, gcloudAccessToken, reviewArchivePrefix, reviewRecordPath, type ReviewHead } from "./gcp.js";
import { GitHubClient, GitHubError, reviewInstallationToken } from "./github.js";
import { githubSnapshot, profileRunSettings, type RunSettings } from "./profile-settings.js";
import { decideReview, REVIEW_LABEL, type ReviewTarget } from "./review-gate.js";
import { INPUTS_TIMEOUT_MS, readCiScreenshots, readCiSummary, readDiff, UNKNOWN_PATCH_ID, type CiSummary, type DiffInfo, type Screenshots } from "./review-inputs.js";
import { postReview, renderReviewBody } from "./review-post.js";

export interface ReviewDeps extends DispatchDeps {
  /**
   * Mints the review-scoped write token (REVIEW_PERMISSIONS). Its own seam: the review path never uses
   * `appToken`, which mints the publisher's broader token.
   */
  reviewToken?: (repo: string) => Promise<string>;
  // Test seams.
  startReview?: typeof startReview;
  cloneReview?: typeof createReviewBundle;
  now?: () => number;
}

const need = (env: Env, name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const REPO_SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,33}$/;
const POSITIVE_INT = /^[1-9][0-9]{0,9}$/;

function repoFrom(env: Env): string {
  const repo = need(env, "GITHUB_REPOSITORY");
  if (!REPO_SLUG.test(repo) || repo.includes("..")) throw new Error("GITHUB_REPOSITORY is not an owner/name slug");
  return repo;
}
function botLoginFrom(env: Env): string {
  const slug = need(env, "GLOBALHOST_APP_SLUG");
  if (!APP_SLUG.test(slug)) throw new Error("GLOBALHOST_APP_SLUG is not an App slug");
  return `${slug}[bot]`;
}
function intFrom(env: Env, name: string): number {
  const raw = need(env, name);
  if (!POSITIVE_INT.test(raw)) throw new Error(`${name} is not a positive integer`);
  return Number(raw);
}
async function readEvent(env: Env): Promise<unknown> {
  return JSON.parse(await readFile(need(env, "GITHUB_EVENT_PATH"), "utf8")) as unknown;
}

// ---- review-gate ----

export interface ReviewGateOutputs {
  /** review: run the review job. unlabel: run the unlabel job, to remove an owner's refused factory:review. ignore: nothing. */
  action: "review" | "ignore" | "unlabel";
  pr?: number;
  /** limits.perRunMinutes: the review job's timeout-minutes, so a live review is never taken over as stale. */
  timeout?: number;
  reason?: string;
}

export async function reviewGateStep(deps: DispatchDeps): Promise<ReviewGateOutputs> {
  const { env } = deps;
  const repo = repoFrom(env);
  const gh = new GitHubClient(need(env, "GITHUB_TOKEN"), deps.fetchImpl);
  let config;
  try {
    config = await loadConfig(gh, repo, deps.registry);
  } catch (err) {
    return { action: "ignore", reason: (err as Error).message };
  }
  const decision = await decideReview({
    gh,
    repo,
    eventName: need(env, "GITHUB_EVENT_NAME"),
    event: await readEvent(env),
    ownerIds: config.owners.map((o) => o.id),
    botLogin: botLoginFrom(env),
    defaultBranch: config.git.defaultBranch,
  });
  const timeout = config.limits.perRunMinutes;
  if (decision.action === "review") return { action: "review", pr: decision.target.pr, timeout };
  if (decision.unlabel) return { action: "unlabel", pr: decision.unlabel, timeout, reason: decision.reason };
  return { action: "ignore", reason: decision.reason };
}

/** Writes review-gate outputs for the next job. Every value is a fixed word or an integer. */
export async function writeReviewGateOutputs(path: string, out: ReviewGateOutputs): Promise<void> {
  const lines = [`action=${out.action}`];
  for (const k of ["pr", "timeout"] as const) if (out[k] !== undefined) lines.push(`${k}=${out[k]}`);
  await appendFile(path, `${lines.join("\n")}\n`);
}

// ---- review ----

/**
 * Minutes assumed spent before this step started (checkout of the action, installing the factory), used only
 * when the workflow doesn't pass GLOBALHOST_JOB_STARTED_AT.
 */
export const JOB_SETUP_MINUTES = 5;
/** Minutes kept after startReview returns: archiving, settling, completing the claim, posting. */
export const AFTER_REVIEW_MINUTES = 2;
/** A review token older than this is minted again before use (GitHub installation tokens expire after 60 min). */
export const REVIEW_TOKEN_REUSE_MS = 50 * 60_000;

export type ReviewStepResult =
  | { outcome: "ignored"; reason: string }
  | { outcome: "paused" }
  | { outcome: "not-claimed"; reason: string }
  | { outcome: "already-recorded" }
  | { outcome: "reviewed"; record: ReviewRecord; posted: number | null };

/**
 * Runs the review job. Throws on a harness error (after settling and, for factory:review, removing the label),
 * so the job goes red; a review that ran but failed or escalated is not an error.
 */
export async function reviewStep(deps: ReviewDeps): Promise<ReviewStepResult> {
  const { env, log } = deps;
  const now = deps.now ?? Date.now;
  const stepStart = now();
  const repo = repoFrom(env);
  const botLogin = botLoginFrom(env);
  const reader = new GitHubClient(need(env, "GITHUB_TOKEN"), deps.fetchImpl);
  const config = await loadConfig(reader, repo, deps.registry);
  const ownerIds = config.owners.map((o) => o.id);
  const gcpToken = deps.gcpToken ?? gcloudAccessToken;

  // The review-scoped token, minted before claiming and reused until it's REVIEW_TOKEN_REUSE_MS old (installation
  // tokens last an hour; a review can run for limits.perRunMinutes), then minted again.
  let minted: { client: GitHubClient; at: number } | undefined;
  const writer = async () => {
    if (minted && now() - minted.at < REVIEW_TOKEN_REUSE_MS) return minted.client;
    const at = now();
    let token: string;
    try {
      token = deps.reviewToken
        ? await deps.reviewToken(repo)
        : await reviewInstallationToken(need(env, "GLOBALHOST_APP_ID"), await accessSecret(gcpToken, "github-app-key", deps.fetchImpl), repo, deps.fetchImpl);
    } catch (err) {
      throw new Error(`can't mint the review App token for ${repo} (App key readable? App installed on the repo?): ${(err as Error).message}`, { cause: err });
    }
    minted = { client: new GitHubClient(token, deps.fetchImpl), at };
    return minted.client;
  };
  const unlabel = async (pr: number) => {
    try {
      await (await writer()).request("DELETE", `/repos/${repo}/issues/${pr}/labels/${encodeURIComponent(REVIEW_LABEL)}`);
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) log(`couldn't remove ${REVIEW_LABEL} from #${pr}: ${(err as Error).message}`);
    }
  };

  const decision = await decideReview({
    gh: reader,
    repo,
    eventName: need(env, "GITHUB_EVENT_NAME"),
    event: await readEvent(env),
    ownerIds,
    botLogin,
    defaultBranch: config.git.defaultBranch,
  });
  if (decision.action === "ignore") {
    log(`review: not reviewing (${decision.reason})`);
    if (decision.unlabel) await unlabel(decision.unlabel);
    return { outcome: "ignored", reason: decision.reason };
  }
  const target = decision.target;
  try {
    const control = new ControlPlane(new ObjectStore(gcpToken, deps.fetchImpl), () => new Date(now()));
    // Everything the run reads from its environment is validated before claiming, so a misconfigured repo fails
    // here instead of stranding an in-flight claim for perRunMinutes + 30.
    const jobTimeout = intFrom(env, "GLOBALHOST_JOB_TIMEOUT_MINUTES");
    const jobStartMs = jobStartedAt(env, stepStart, jobTimeout);
    if (jobTimeout > config.limits.perRunMinutes) {
      throw new Error(`the review job's timeout (${jobTimeout} min) is over limits.perRunMinutes (${config.limits.perRunMinutes})`);
    }
    const runId = `${new Date(stepStart).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-review-${target.pr}-${githubIdEnv(env, "GITHUB_RUN_ID")}-${intFrom(env, "GITHUB_RUN_ATTEMPT")}`;
    const api = reviewApi(env, deps);
    if (!deps.reviewToken) intFrom(env, "GLOBALHOST_APP_ID");
    need(env, "RUNNER_TEMP");
    if (await control.paused()) {
      log("review: the factory is paused; nothing ran");
      return { outcome: "paused" };
    }
    // Mint the write token now: an unreadable App key or an App not installed on the repo fails here, before a
    // claim, reservation or session exists, instead of after a paid review that can't be posted.
    await writer();
    const head: ReviewHead = { repo, pr: target.pr, sha: target.sha };
    const claim = await control.reviewClaim(head, runId, { perRunMinutes: config.limits.perRunMinutes, rereview: target.rereview });
    if (!claim.claimed) {
      log(`review: ${target.sha.slice(0, 12)} not claimed (${claim.reason})`);
      return { outcome: "not-claimed", reason: claim.reason };
    }
    log(`review: PR #${target.pr} at ${target.sha.slice(0, 12)}, attempt ${claim.claim.attempt} (${runId})`);
    return await runClaimed({ deps, api, reader, writer, control, config, ownerIds, botLogin, target, head, runId, jobDeadlineMs: jobStartMs + jobTimeout * 60_000, now });
  } finally {
    if (target.viaLabel) await unlabel(target.pr);
  }
}

interface ClaimedContext {
  deps: ReviewDeps;
  api: ManagedAgentsApi;
  reader: GitHubClient;
  writer: () => Promise<GitHubClient>;
  control: ControlPlane;
  config: Awaited<ReturnType<typeof loadConfig>>;
  ownerIds: number[];
  botLogin: string;
  target: ReviewTarget;
  head: ReviewHead;
  runId: string;
  /** When the Actions job will be killed (epoch ms). */
  jobDeadlineMs: number;
  now: () => number;
}

/**
 * The Anthropic client of the review's own federation rule (ADR-0014). The federation variables are checked even
 * when a test injects the API; the job's OIDC request variables only when it doesn't. Building it makes no request.
 */
function reviewApi(env: Env, deps: ReviewDeps): ManagedAgentsApi {
  const processEnv = env as NodeJS.ProcessEnv;
  const ids = federationIdsFromEnv(processEnv);
  if (deps.api) return deps.api;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("no GitHub Actions OIDC token available (is id-token: write set?)");
  }
  return sdkApi(anthropicClient(ids, githubActionsIdentity(processEnv, deps.fetchImpl)));
}

/**
 * When the job started, from GLOBALHOST_JOB_STARTED_AT (epoch seconds, written by the job's first step). Without
 * it, JOB_SETUP_MINUTES before this step. A value in the future or older than the job's timeout is refused.
 */
export function jobStartedAt(env: Env, stepStart: number, jobTimeoutMinutes: number): number {
  const raw = env.GLOBALHOST_JOB_STARTED_AT;
  if (raw === undefined || raw === "") return stepStart - JOB_SETUP_MINUTES * 60_000;
  if (!/^[1-9][0-9]{8,10}$/.test(raw)) throw new Error("GLOBALHOST_JOB_STARTED_AT is not epoch seconds");
  const ms = Number(raw) * 1000;
  if (ms > stepStart + 60_000 || ms < stepStart - jobTimeoutMinutes * 60_000) throw new Error("GLOBALHOST_JOB_STARTED_AT is outside this job's lifetime");
  return ms;
}

/** What the archived inputs.json holds: what the reviewer and the scan saw, and what the harness changed. */
interface InputsRecord {
  version: 1;
  repo: string;
  pr: number;
  sha: string;
  issue: number;
  ciRunId: number;
  rereview: boolean;
  trigger: "ci-success" | "owner-label";
  diff: { paths: string[]; addedLines: number; commits: number; patchId: string } | null;
  ciSummary: CiSummary | null;
  screenshots: { label: string }[];
  screenshotProblems: string[];
  /** The overall input deadline cut reading CI logs or screenshots short. */
  inputsDeadlineReached: boolean;
  taint: ReviewRecord["taint"];
  /** Findings whose file is outside the diff: the harness cleared file and line. */
  outsideDiff: { index: number; file: string }[];
  timeoutMinutes: number | null;
}

async function runClaimed(c: ClaimedContext): Promise<ReviewStepResult> {
  const { deps, reader, control, config, target, head, runId, now } = c;
  const { env, log } = deps;
  const limits = config.limits;
  const outDir = join(need(env, "RUNNER_TEMP"), "globalhost", runId);
  const store = new ObjectStore(deps.gcpToken ?? gcloudAccessToken, deps.fetchImpl);

  // What the failure path needs to settle honestly.
  let costUsd = 0;
  let sessionId: string | null = null;
  let bundle: ReviewBundle | undefined;
  let diff: DiffInfo | undefined;
  let scanHits: ScanHit[] = [];
  let shots: Screenshots | undefined;
  let record: ReviewRecord | undefined;
  let run: ReviewRun | undefined;
  const outsideDiff = new Set<number>();
  let archived = false;
  let settle = true;
  let primary: unknown;
  let taint: ReviewRecord["taint"] = { tainted: false, reasons: [] };

  try {
    const reserved = await control.reserveReview(head, runId, { perRun: limits.reviewPerRunUsd, perPr: limits.reviewPerPrUsd, dailyUsd: limits.dailyUsd });
    if (!reserved.reserved && reserved.reason === "already-recorded") {
      settle = false;
      return { outcome: "already-recorded" };
    }

    let ci: CiSummary | null = null;
    let timeoutMinutes: number | null = null;
    if (reserved.reserved) {
      const settings: RunSettings = deps.profiles
        ? await profileRunSettings(deps.profiles, config, await githubSnapshot(reader, head.repo, config.git.defaultBranch))
        : {};
      if ((settings.environment?.allowedHosts.length ?? 0) > 0) taint = { tainted: true, reasons: ["registry-egress"] };

      bundle = await (deps.cloneReview ?? createReviewBundle)(
        `https://github.com/${head.repo}.git`,
        { baseBranch: target.pull.base.ref, pr: target.pr, headSha: target.sha },
        env.GITHUB_TOKEN,
      );
      diff = await readDiff(bundle.bareDir, bundle.mergeBaseSha, bundle.headSha);
      // One deadline across CI logs and the screenshot artifact; past it, the review goes ahead with what was read.
      const inputsSignal = AbortSignal.timeout(INPUTS_TIMEOUT_MS);
      ci = await readCiSummary(reader, head.repo, target.ciRunId, inputsSignal).catch((err: unknown) => {
        log(`review: CI summary unavailable: ${(err as Error).message}`);
        return null;
      });
      shots = await readCiScreenshots(reader, head.repo, target.ciRunId, { signal: inputsSignal }).catch((err: unknown) => {
        log(`review: screenshots unavailable: ${(err as Error).message}`);
        return { dir: null, files: [], problems: ["screenshot artifact unavailable"] };
      });
      for (const p of shots.problems) log(`review: ${p}`);
      // Everything the reviewer reads besides the repo is scanned too: CI output, the PR's title and body, and
      // the screenshot labels (artifact entry names).
      const artifacts = [
        { name: "pr-title", text: target.pull.title },
        { name: "pr-body", text: target.pull.body ?? "" },
        ...(ci ? [{ name: "ci-summary", text: ci.text }] : []),
        // Labels are file names: each is scanned as is and with separators read as spaces, like diff paths.
        ...(shots.files.length
          ? [{ name: "screenshot-labels", text: shots.files.map((f) => `${f.label}\n${f.label.replace(/[-_./]/g, " ")}`).join("\n\n") }]
          : []),
      ];
      scanHits = scanDiff({ addedLines: diff.addedLines, commitMessages: diff.commitMessages, paths: diff.paths, artifacts });

      // startReview must return by the job's deadline less the post-review work, however long its own setup takes.
      const reviewDeadline = c.jobDeadlineMs - AFTER_REVIEW_MINUTES * 60_000;
      const remaining = Math.floor((reviewDeadline - now()) / 60_000);
      timeoutMinutes = Math.min(limits.perRunMinutes, remaining - REVIEW_SETTLE_MARGIN_MINUTES);
      if (timeoutMinutes < 1) throw new Error("not enough of the job's time is left to run a review");

      const prepared = bundle;
      // From here a session may exist: an error with no cost to go on is charged the run's cap, unless startReview
      // says it failed before opening one (ReviewNotStartedError).
      costUsd = limits.reviewPerRunUsd;
      try {
        run = await (deps.startReview ?? startReview)(
          {
            runId,
            repo: head.repo,
            pr: target.pr,
            headSha: target.sha,
            baseBranch: target.pull.base.ref,
            issue: target.issue,
            prTitle: target.pull.title,
            prBody: target.pull.body ?? "",
            ciSummary: ci?.text,
            screenshots: shots.files,
            budgetUsd: limits.reviewPerRunUsd,
            timeoutMinutes,
            // The time this step can still give the review, so startReview enforces the settle margin against it.
            hardTimeoutMinutes: remaining,
            deadlineEpochMs: reviewDeadline,
            outDir,
            environment: settings.environment,
            guidance: settings.guidance,
            toolchain: settings.toolchain,
            skillDirs: deps.skillDirs ? [...deps.skillDirs] : undefined,
            ownerIds: c.ownerIds,
          },
          {
            api: c.api,
            github: new GitHubReader(env.GITHUB_TOKEN, deps.fetchImpl),
            githubToken: env.GITHUB_TOKEN,
            log,
            onEvent: (e: { type: string; toolName?: string }) => {
              if (e.type === "agent.tool_use") log(`  · ${e.toolName ?? "tool"}`);
            },
            // The bundle the diff was read from: the reviewer sees exactly what was scanned.
            cloneReview: async () => prepared,
          },
        );
      } catch (err) {
        // Failed before a session could exist: nothing ran, nothing to charge.
        if (err instanceof ReviewNotStartedError) costUsd = 0;
        if (err instanceof ReviewRunError) {
          costUsd = safeCost(err.costUsd, limits.reviewPerRunUsd);
          sessionId = err.sessionId;
        }
        throw err;
      }
      costUsd = safeCost(run.costUsd, limits.reviewPerRunUsd);
      sessionId = run.sessionId;
    }

    const status: ReviewStatus = run ? run.status : "budget_exhausted";
    const diffPaths = new Set(diff?.paths ?? []);
    const findings: Finding[] = (run?.output?.findings ?? []).map((f, i) => {
      if (f.file === null || diffPaths.has(f.file)) return f;
      outsideDiff.add(i);
      return { ...f, file: null, line: null };
    });
    record = buildRecord(c, {
      run,
      status,
      output: run?.output ?? null,
      findings,
      budgetExhausted: !reserved.reserved,
      scanHits,
      costUsd,
      sessionId,
      baseSha: run?.baseSha ?? bundle?.baseSha ?? target.pull.base.sha,
      patchId: diff?.patchId ?? UNKNOWN_PATCH_ID,
      taint,
      prSpendUsd: addCapped(await control.prReviewSpend(head), costUsd),
    });

    const inputs: InputsRecord = {
      version: 1,
      repo: head.repo,
      pr: target.pr,
      sha: target.sha,
      issue: target.issue,
      ciRunId: target.ciRunId,
      rereview: target.rereview,
      trigger: target.viaLabel ? "owner-label" : "ci-success",
      diff: diff ? { paths: diff.paths, addedLines: diff.addedLines.length, commits: diff.commitMessages.length, patchId: diff.patchId } : null,
      ciSummary: ci,
      screenshots: (shots?.files ?? []).map((s) => ({ label: s.label })),
      screenshotProblems: shots?.problems ?? [],
      inputsDeadlineReached: ci?.deadlineReached === true || (shots?.problems ?? []).some((p) => p.startsWith("input deadline")),
      taint,
      outsideDiff: [...outsideDiff].map((index) => ({ index, file: run!.output!.findings[index]!.file! })),
      timeoutMinutes,
    };
    await archiveReview(store, head, runId, outDir, run !== undefined, inputs, record);
    archived = true;
  } catch (err) {
    primary = err;
  } finally {
    if (shots?.dir) await rm(shots.dir, { recursive: true, force: true }).catch(() => undefined);
    if (bundle) await rm(join(bundle.bareDir, ".."), { recursive: true, force: true }).catch(() => undefined);
  }

  if (settle) {
    // Settle whatever happened. A record that wasn't archived is settled as a failed run instead, so the shadow
    // index never points at a review that isn't there. Building that fallback is inside the try, so a problem
    // there never hides the original error; a minimal entry is the last resort.
    try {
      let entryRecord: ReviewRecord;
      if (archived && record) entryRecord = record;
      else {
        const failed = (p: Partial<RecordParts>) =>
          buildRecord(c, {
            run: undefined,
            status: "failed",
            output: null,
            findings: [],
            budgetExhausted: false,
            scanHits,
            costUsd,
            sessionId,
            baseSha: bundle?.baseSha ?? target.pull.base.sha,
            patchId: diff?.patchId ?? UNKNOWN_PATCH_ID,
            taint,
            prSpendUsd: costUsd,
            ...p,
          });
        try {
          entryRecord = failed({});
        } catch (err) {
          log(`review: fallback record invalid (${(err as Error).message}); settling a minimal one`);
          entryRecord = failed({ scanHits: [], sessionId: null, baseSha: target.sha, patchId: UNKNOWN_PATCH_ID, taint: { tainted: false, reasons: [] } });
        }
      }
      await control.recordReviewRun(head, shadowEntryFromRecord(entryRecord));
      log(`review: settled $${costUsd.toFixed(2)} (${entryRecord.status})`);
    } catch (err) {
      if (primary !== undefined) log(`review: settling failed too: ${(err as Error).message}`);
      else primary = err;
    }
  }
  if (primary !== undefined) throw primary;
  if (!record) throw new Error("review: no record"); // unreachable: archived implies a record

  if (!(await control.completeReviewClaim(head, runId))) {
    log("review: another run holds this SHA's claim now; not posting");
    return { outcome: "reviewed", record, posted: null };
  }
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${head.repo}/actions/runs/${need(env, "GITHUB_RUN_ID")}`;
  const body = renderReviewBody({ record, summary: run?.output?.summary ?? null, outsideDiff, runUrl });
  const posted = await postReview({ gh: await c.writer(), repo: head.repo, pr: target.pr, record, body, botLogin: c.botLogin });
  log(`review: posted review ${posted} (${record.overall})`);
  return { outcome: "reviewed", record, posted };
}

const safeCost = (usd: number, fallback: number) => (Number.isFinite(usd) && usd >= 0 && usd <= MAX_REVIEW_USD ? usd : fallback);
const addCapped = (a: number, b: number) => (Number.isFinite(a + b) ? Math.min(MAX_REVIEW_USD, Math.round((a + b) * 1e6) / 1e6) : MAX_REVIEW_USD);

interface RecordParts {
  run: ReviewRun | undefined;
  status: ReviewStatus;
  output: ReviewOutput | null;
  findings: Finding[];
  budgetExhausted: boolean;
  scanHits: ScanHit[];
  costUsd: number;
  sessionId: string | null;
  baseSha: string;
  patchId: string;
  taint: ReviewRecord["taint"];
  prSpendUsd: number;
}

/** The harness-stamped record. Verdicts come only from overallVerdict over the validated output. */
function buildRecord(c: ClaimedContext, p: RecordParts): ReviewRecord {
  const verdict = overallVerdict(p.output, { scanHits: p.scanHits, budgetExhausted: p.budgetExhausted, status: p.status });
  return ReviewRecordSchema.parse({
    version: 1,
    sha: p.run?.headSha ?? c.head.sha,
    baseSha: p.baseSha,
    patchId: p.patchId,
    runId: c.runId,
    sessionId: p.sessionId,
    model: p.run?.model ?? DEFAULT_MODEL,
    agentVersion: p.run?.agent.version ?? null,
    ciRunId: c.target.ciRunId,
    status: p.status,
    verdicts: verdict.verdicts,
    overall: verdict.overall,
    escalations: verdict.escalations,
    taint: p.taint,
    scanHits: p.scanHits,
    findings: p.findings,
    costUsd: p.costUsd,
    prSpendUsd: p.prSpendUsd,
    reviewPath: reviewRecordPath(c.head, c.runId),
    postedReviewId: null,
    recordedAt: new Date(c.now()).toISOString(),
    verification: null,
  });
}

/** Create-only archive of one attempt; review.json goes last, so its presence means the attempt is complete. */
async function archiveReview(
  store: ObjectStore,
  head: ReviewHead,
  runId: string,
  outDir: string,
  ran: boolean,
  inputs: InputsRecord,
  record: ReviewRecord,
): Promise<void> {
  const prefix = reviewArchivePrefix(head, runId);
  const put = async (name: string, data: string | Buffer, contentType = "application/json") => {
    if ((await store.write(RUNS_BUCKET, `${prefix}${name}`, data, "0", contentType)) === "conflict") {
      throw new Error(`gs://${RUNS_BUCKET}/${prefix}${name} already exists`);
    }
  };
  if (ran) {
    const raw = await readFile(join(outDir, REVIEW_OUTPUT_FILE)).catch(() => undefined);
    // The reviewer's bytes as they came: possibly invalid, so never served as JSON.
    if (raw) await put("output.raw.json", raw, "application/octet-stream");
    await put("run.json", await readFile(join(outDir, "run.json")));
  }
  await put("inputs.json", `${JSON.stringify(inputs, null, 2)}\n`);
  await put("review.json", `${JSON.stringify(record, null, 2)}\n`);
}
