// The harness: drive one role's session for one issue and turn its outputs into a trusted run.json.
// It's host-specific (RunnerHost = Managed Agents here, ADR-0011) but publishing is not: the dispatcher
// (P1-07) and `globalhost run` both call these functions and then decide what to do with the record.
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import {
  checkToolchain,
  parseReviewOutput,
  ToolchainSchema,
  toolchainProblems,
  type RepoSnapshot,
  type ReviewOutput,
  type ReviewOutputIssue,
  type ReviewStatus,
  type Toolchain,
  type ToolchainRecord,
} from "@globalhost/core";
import { REVIEW_OUTPUT_FILE, definitionHash, roleDefinition, type RoleId } from "@globalhost/roles";
import { createRepoBundle, createReviewBundle, gitSnapshot, inspectResultBundle, type RepoBundle, type ReviewBundle } from "./git.js";
import { ensureSkill } from "./skills.js";
import type { GitHubReader } from "./github.js";
import {
  countMessages,
  ensureAgent,
  ensureEnvironment,
  waitForTurn,
  type AgentRef,
  type EnvironmentSpec,
  type ManagedAgentsApi,
  type OutputFile,
  type SessionEvent,
} from "./managed-agents.js";
import {
  REPO_BUNDLE_MOUNT,
  SCREENSHOT_MOUNT_DIR,
  buildAssessTaskMessage,
  buildFeedbackMessage,
  buildReviewTaskMessage,
  buildTaskMessage,
} from "./prompt.js";
import {
  AgentReportSchema,
  ReviewRunSchema,
  RunRecordSchema,
  type AgentReport,
  type ReviewRun,
  type RunRecord,
  type RunStatus,
} from "./records.js";

export const DEFAULT_ENVIRONMENT: EnvironmentSpec = { name: "globalhost-default", allowedHosts: [] };

/** Output files the harness accepts, with size caps. Anything else the agent writes is ignored. */
const OUTPUT_LIMITS: Record<string, number> = {
  "report.json": 256 * 1024,
  "plan.md": 256 * 1024,
  "result.bundle": 100 * 1024 * 1024,
  "assessment.md": 256 * 1024,
  // The factory.yaml parser's own cap (MAX_FACTORY_YAML_BYTES).
  "factory.yaml": 64 * 1024,
  // Comfortably above the largest output ReviewOutputSchema accepts; anything bigger is invalid, not clipped.
  [REVIEW_OUTPUT_FILE]: 1024 * 1024,
};
/** Which of those each role may hand back (plus screenshots). An assessor's result.bundle is never even fetched. */
const ROLE_OUTPUTS: Record<RoleId, readonly string[]> = {
  planner: ["report.json", "plan.md"],
  builder: ["report.json", "result.bundle"],
  assessor: ["report.json", "assessment.md", "factory.yaml"],
  reviewer: ["report.json", REVIEW_OUTPUT_FILE],
};
const SCREENSHOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/;
const SCREENSHOT_LIMIT = 10 * 1024 * 1024;
const MAX_SCREENSHOTS = 20;
const CLOCK_SKEW_MS = 120_000;

export interface RunDeps {
  api: ManagedAgentsApi;
  github: GitHubReader;
  /** Read-only token for cloning private repos; never sent to the session. */
  githubToken?: string;
  log: (line: string) => void;
  onEvent?: (e: SessionEvent) => void;
  now?: () => number;
  /** Test seam for cloning; defaults to a bare clone from GitHub. */
  cloneRepo?: typeof createRepoBundle;
  /** How long a failed review waits for its interrupt to land before reading the cost (default 30 s). */
  settleMs?: number;
  /** Test seam for bundling a PR for review; defaults to createReviewBundle. */
  cloneReview?: typeof createReviewBundle;
}

/**
 * Resolves the tool versions a run must use from a snapshot of its base commit. The caller builds it from the
 * parts' profiles (they do the reading); the runner decides which commit it sees: the bundle's base, never a head.
 */
export type ToolchainResolver = (base: RepoSnapshot) => Promise<Toolchain>;

/**
 * The toolchain at `commit` of the bare repo, validated. A resolver error doesn't stop the run: it is logged, a
 * fixed-text problem is recorded, and no versions are required.
 */
export async function resolveToolchain(
  resolver: ToolchainResolver | undefined,
  repoDir: string,
  commit: string,
  log: (line: string) => void,
  problems: string[],
): Promise<Toolchain | undefined> {
  if (!resolver) return undefined;
  try {
    const toolchain = ToolchainSchema.parse(await resolver(await gitSnapshot(repoDir, commit)));
    log(`toolchain at ${commit.slice(0, 12)}: ${toolchain.tools.map((t) => `${t.tool} ${t.range}`).join(", ") || "nothing pinned"}`);
    return toolchain;
  } catch (err) {
    log(`toolchain: couldn't resolve it (${(err instanceof Error ? err.message : String(err)).slice(0, 300)})`);
    problems.push("toolchain: the base commit's tool versions couldn't be resolved, so none were required");
    return undefined;
  }
}

/** Compares the agent's reported versions with the requirement and adds a problem line per mismatch. */
function toolchainOutcome(required: Toolchain | undefined, reportedRaw: unknown, problems: string[]): ToolchainRecord | undefined {
  if (!required) return undefined;
  const record = checkToolchain(required, reportedRaw);
  problems.push(...toolchainProblems(record));
  return record;
}

export interface StartSpec {
  runId: string;
  role: RoleId;
  repo: string;
  issue: number;
  budgetUsd: number;
  timeoutMinutes: number;
  outDir: string;
  model?: string;
  environment?: EnvironmentSpec;
  /** Owners by immutable GitHub user ID (ADR-0013). Defaults to the repo's owner account. */
  ownerIds?: number[];
  guidance?: string;
  /** Absolute skill directories (skills/<name>) from the parts' profiles; attached to the agent, pinned. */
  skillDirs?: string[];
  approvedPlan?: string;
  /** Resolves required tool versions from the base commit the run starts from. */
  toolchain?: ToolchainResolver;
}

export interface ResumeSpec {
  sessionId: string;
  feedback: string;
  /** Added on top of what the session has spent so far. */
  addBudgetUsd: number;
  timeoutMinutes: number;
  outDir: string;
  /** Re-checks the resumed turn's reported versions against the run's stored base commit. */
  toolchain?: ToolchainResolver;
}

export const branchFor = (issue: number) => `factory/issue-${issue}`;

const META = {
  run: "globalhost_run",
  repo: "globalhost_repo",
  issue: "globalhost_issue",
  role: "globalhost_role",
  base: "globalhost_base",
  budget: "globalhost_budget_usd",
  model: "globalhost_model",
  pr: "globalhost_pr",
  head: "globalhost_head",
} as const;

interface SessionLaunch {
  runId: string;
  role: RoleId;
  repo: string;
  /** Null for an assessment. */
  issue: number | null;
  budgetUsd: number;
  model?: string;
  environment?: EnvironmentSpec;
  skillDirs?: string[];
  /** A review's PR and head; its title and metadata name the PR. */
  review?: { pr: number; headSha: string };
  /** Extra read-only files to mount (local path → mount path under the uploads root). */
  mounts?: readonly { localPath: string; mountPath: string }[];
  /** Set to true just before createSession is called: from then on a session may exist. */
  progress?: { creating: boolean };
}

/** Syncs the role's agent (with its pinned skills) and environment, uploads the bundle, and opens the session. */
async function openSession(deps: RunDeps, l: SessionLaunch, bundle: RepoBundle,
): Promise<{ sessionId: string; model: string; agent: AgentRef; environmentId: string }> {
  const skills = [];
  for (const dir of l.skillDirs ?? []) skills.push(await ensureSkill(deps.api, dir));
  const def = roleDefinition(l.role, l.model, skills);
  const agent = await ensureAgent(deps.api, def, definitionHash(def));
  const environmentId = await ensureEnvironment(deps.api, l.environment ?? DEFAULT_ENVIRONMENT);
  const files = [{ fileId: await deps.api.uploadFile(bundle.bundlePath), mountPath: REPO_BUNDLE_MOUNT }];
  for (const m of l.mounts ?? []) files.push({ fileId: await deps.api.uploadFile(m.localPath), mountPath: m.mountPath });

  const title =
    l.review ? `${l.repo} PR #${l.review.pr} ${l.role}`
    : l.issue === null ? `${l.repo} ${l.role}`
    : `${l.repo}#${l.issue} ${l.role}`;
  if (l.progress) l.progress.creating = true;
  const sessionId = await deps.api.createSession({
    agent,
    environmentId,
    budgetCents: Math.round(l.budgetUsd * 100),
    title,
    metadata: {
      [META.run]: l.runId,
      [META.repo]: l.repo,
      [META.issue]: l.issue === null ? "" : String(l.issue),
      [META.role]: l.role,
      [META.base]: bundle.baseSha,
      [META.budget]: String(l.budgetUsd),
      [META.model]: def.model,
      ...(l.review ? { [META.pr]: String(l.review.pr), [META.head]: l.review.headSha } : {}),
    },
    files,
  });
  deps.log(`session ${sessionId} (agent ${def.agentName} v${agent.version}, budget $${l.budgetUsd})`);
  return { sessionId, model: def.model, agent, environmentId };
}

export async function startRun(spec: StartSpec, deps: RunDeps): Promise<RunRecord> {
  if (spec.role === "assessor") throw new Error("the assessor runs through startAssessment, not on an issue");
  if (spec.role === "reviewer") throw new Error("the reviewer runs through startReview, on a pull request");
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const repo = await deps.github.repo(spec.repo);
  const issue = await deps.github.issue(spec.repo, spec.issue);
  const ownerIds = new Set(spec.ownerIds ?? [repo.owner.id]);
  if (!ownerIds.has(issue.author.id)) deps.log(`note: issue #${spec.issue} wasn't opened by an owner; its text is fenced as data`);

  const bundle = await (deps.cloneRepo ?? createRepoBundle)(repo.clone_url, repo.default_branch, deps.githubToken);
  try {
    deps.log(`base ${repo.default_branch}@${bundle.baseSha.slice(0, 12)}`);
    const preProblems: string[] = [];
    const toolchain = await resolveToolchain(spec.toolchain, bundle.bareDir, bundle.baseSha, deps.log, preProblems);
    const { sessionId, model } = await openSession(deps, spec, bundle);
    const message = buildTaskMessage({
      role: spec.role,
      repo: spec.repo,
      defaultBranch: repo.default_branch,
      baseSha: bundle.baseSha,
      issue,
      ownerIds,
      branch: spec.role === "builder" ? branchFor(spec.issue) : undefined,
      guidance: spec.guidance,
      approvedPlan: spec.approvedPlan,
      toolchain,
    });
    return await driveTurn(deps, {
      runId: spec.runId,
      role: spec.role,
      repo: spec.repo,
      issue: spec.issue,
      sessionId,
      bundle,
      model,
      message,
      priorMessages: 0,
      budgetUsd: spec.budgetUsd,
      timeoutMinutes: spec.timeoutMinutes,
      outDir: spec.outDir,
      startedAt,
      toolchain,
      preProblems,
    });
  } finally {
    await rm(join(bundle.bareDir, ".."), { recursive: true, force: true });
  }
}

export interface AssessSpec {
  runId: string;
  repo: string;
  budgetUsd: number;
  timeoutMinutes: number;
  outDir: string;
  model?: string;
  environment?: EnvironmentSpec;
  skillDirs?: string[];
  /**
   * Facts the caller gathered with trusted code, as markdown. The caller must already have fenced everything
   * repo-derived in it (names, paths, descriptions) with fenceUntrusted; it goes into the message as is.
   */
  facts: string;
  /** Owner-authored notes (e.g. open items to raise); sanitized, not fenced. */
  ownerNotes?: string;
}

/** Runs the assessor on a repo's default branch (ONBOARDING Stage 1). Outputs: assessment.md, report.json. */
export async function startAssessment(spec: AssessSpec, deps: RunDeps): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const repo = await deps.github.repo(spec.repo);
  const bundle = await (deps.cloneRepo ?? createRepoBundle)(repo.clone_url, repo.default_branch, deps.githubToken);
  try {
    deps.log(`base ${repo.default_branch}@${bundle.baseSha.slice(0, 12)}`);
    const { sessionId, model } = await openSession(deps, { ...spec, role: "assessor", issue: null }, bundle);
    const message = buildAssessTaskMessage({
      repo: spec.repo,
      defaultBranch: repo.default_branch,
      baseSha: bundle.baseSha,
      facts: spec.facts,
      ownerNotes: spec.ownerNotes,
    });
    return await driveTurn(deps, {
      runId: spec.runId,
      role: "assessor",
      repo: spec.repo,
      issue: null,
      sessionId,
      bundle,
      model,
      message,
      priorMessages: 0,
      budgetUsd: spec.budgetUsd,
      timeoutMinutes: spec.timeoutMinutes,
      outDir: spec.outDir,
      startedAt,
    });
  } finally {
    await rm(join(bundle.bareDir, ".."), { recursive: true, force: true });
  }
}

export interface ScreenshotInput {
  /** Local file the harness already holds (e.g. downloaded from the preview workflow's artifact). */
  path: string;
  /**
   * What the caller calls it (e.g. the artifact's file name). Untrusted: it is shown to the reviewer only inside
   * an untrusted fence, never used as a path. The mounted name is assigned by the harness.
   */
  label?: string;
}

export interface ScreenshotMount {
  /** Harness-assigned: screenshot-01.png, screenshot-02.png, … */
  name: string;
  label?: string;
  /** The harness's own copy, in a directory it created; this is what gets uploaded. */
  localPath: string;
  /** Under SCREENSHOT_MOUNT_DIR, relative to the session's uploads root. */
  mountPath: string;
}

export const MAX_REVIEW_SCREENSHOTS = MAX_SCREENSHOTS;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_LABEL = 200;

/**
 * Copies screenshots into a fresh harness-owned directory under harness-assigned names. Each input is opened
 * once with O_NOFOLLOW (a symlinked file is refused), its parent must resolve to itself (no symlinked
 * directories), and the bytes read through that one handle are checked (regular file, size cap, PNG header)
 * and written to the copy, so what was checked is what gets uploaded. Throws on the first problem; the caller
 * removes `dir` when done.
 */
export async function prepareScreenshotMounts(inputs: readonly ScreenshotInput[]): Promise<{ dir: string; mounts: ScreenshotMount[] }> {
  if (inputs.length > MAX_REVIEW_SCREENSHOTS) throw new Error(`too many screenshots (${inputs.length}, max ${MAX_REVIEW_SCREENSHOTS})`);
  const dir = await mkdtemp(join(tmpdir(), "globalhost-shots-"));
  try {
    const mounts: ScreenshotMount[] = [];
    for (const [i, input] of inputs.entries()) {
      const name = `screenshot-${String(i + 1).padStart(2, "0")}.png`;
      const given = resolve(input.path);
      if ((await realpath(dirname(given))) !== dirname(given)) throw new Error(`screenshot ${i + 1}: its directory is reached through a symlink; pass a canonical (realpath) path`);
      let data: Buffer;
      // O_NONBLOCK so a FIFO opens immediately (and then fails the regular-file check) instead of hanging.
      const fh = await open(given, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch((err: NodeJS.ErrnoException) => {
        throw new Error(`screenshot ${i + 1}: can't open it without following links (${err.code ?? "error"})`);
      });
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new Error(`screenshot ${i + 1} is not a regular file`);
        if (st.size === 0 || st.size > SCREENSHOT_LIMIT) throw new Error(`screenshot ${i + 1} is ${st.size} bytes (limit ${SCREENSHOT_LIMIT})`);
        data = Buffer.alloc(st.size);
        const { bytesRead } = await fh.read(data, 0, st.size, 0);
        if (bytesRead !== st.size) throw new Error(`screenshot ${i + 1} changed while it was read`);
      } finally {
        await fh.close();
      }
      if (!data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error(`screenshot ${i + 1} is not a PNG`);
      const localPath = join(dir, name);
      await writeFile(localPath, data, { flag: "wx", mode: 0o600 });
      const label = input.label === undefined ? undefined : input.label.slice(0, MAX_LABEL);
      mounts.push({ name, ...(label ? { label } : {}), localPath, mountPath: posix.join(SCREENSHOT_MOUNT_DIR, name) });
    }
    return { dir, mounts };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Minutes the harness may spend after a review's timeout (interrupt, settle, output retries, writing run.json).
 * A caller with a hard job timeout must pass it as `hardTimeoutMinutes`; startReview refuses a `timeoutMinutes`
 * that doesn't leave this margin.
 */
export const REVIEW_SETTLE_MARGIN_MINUTES = 3;

export interface ReviewSpec {
  runId: string;
  repo: string;
  pr: number;
  /** The head to review (from the CI run or the PR event); the review is refused if the PR has moved. */
  headSha: string;
  /** The PR's base branch. Must be the repo's default branch: factory PRs never target anything else. */
  baseBranch: string;
  /** The issue the PR implements (factory/issue-<n>); its title and body are the spec, fenced. Comments are not passed. */
  issue?: number;
  /** PR title and description (builder-written; fenced). */
  prTitle?: string;
  prBody?: string;
  /** The caller's summary of the CI run on this head (fenced). */
  ciSummary?: string;
  /** Preview screenshots as local files, copied and mounted read-only under SCREENSHOT_MOUNT_DIR. */
  screenshots?: readonly ScreenshotInput[];
  budgetUsd: number;
  timeoutMinutes: number;
  /** The job's own hard limit, if any; timeoutMinutes must be at most this minus REVIEW_SETTLE_MARGIN_MINUTES. */
  hardTimeoutMinutes?: number;
  /**
   * Absolute time (epoch ms) by which startReview must have returned, e.g. the job's own deadline less the
   * caller's post-review work. The turn is cut at this minus REVIEW_SETTLE_MARGIN_MINUTES however long the
   * setup (clone, skill and agent sync, uploads) took, and the waits after an interrupt stay inside it.
   */
  deadlineEpochMs?: number;
  outDir: string;
  /** Defaults to the builder's pinned model (DEFAULT_MODEL). */
  model?: string;
  environment?: EnvironmentSpec;
  skillDirs?: string[];
  ownerIds?: number[];
  guidance?: string;
  /** Resolves required tool versions at the PR's merge base with the base branch; the PR head is never read. */
  toolchain?: ToolchainResolver;
}

/** Fail-closed status for a review: how the session stopped first, then whether the output passed the schema. */
export function decideReviewStatus(stopReason: string, output: "valid" | "invalid" | "missing"): ReviewStatus {
  if (stopReason === "budget_reached") return "budget_exhausted";
  if (stopReason === "timeout") return "timeout";
  if (stopReason !== "end_turn") return "failed";
  if (output === "invalid") return "invalid_output";
  if (output === "missing") return "missing_output";
  return "completed";
}

export type ReviewOutputCheck =
  | { kind: "valid"; output: ReviewOutput }
  | { kind: "invalid"; issues: ReviewOutputIssue[] }
  | { kind: "missing" };

/**
 * True if any object in `text` (already known to be valid JSON) repeats a key. JSON.parse keeps the last copy,
 * so `{"verdicts":…escalate…,"verdicts":…pass…}` would otherwise read as pass. Keys are compared decoded, so
 * `"a"` and `"a"` are the same key. One linear pass.
 */
export function hasDuplicateJsonKeys(text: string): boolean {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack.at(-1);
      if (top) top.expectKey = true;
    }
  }
  return false;
}

/**
 * Parses the reviewer's raw output file: strict UTF-8 (no BOM), exactly one JSON value, no duplicate keys, then
 * core's parseReviewOutput. Never clips or repairs. Issues use fixed text so nothing the reviewer wrote is echoed.
 */
export function checkReviewOutput(raw: Buffer | undefined, oversized: boolean): ReviewOutputCheck {
  if (oversized) return { kind: "invalid", issues: [{ path: "", code: "too_big", message: "output file over its size limit" }] };
  if (raw === undefined) return { kind: "missing" };
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", issues: [{ path: "", code: "invalid_json", message: "not a single JSON value in UTF-8" }] };
  }
  if (hasDuplicateJsonKeys(text)) return { kind: "invalid", issues: [{ path: "", code: "duplicate_key", message: "an object repeats a key" }] };
  const parsed = parseReviewOutput(value);
  return parsed.ok ? { kind: "valid", output: parsed.output } : { kind: "invalid", issues: parsed.issues };
}

/**
 * Thrown when a review fails before any session could exist (before createSession was called): nothing ran,
 * so the caller settles it at $0.
 */
export class ReviewNotStartedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewNotStartedError";
  }
}

/** The shortest wait for an interrupt to land, even when a deadline has (nearly) passed. */
const MIN_INTERRUPT_WAIT_MS = 10_000;

/** Least time a review needs between opening its session and its deadline's settle margin to be worth sending. */
const MIN_REVIEW_TURN_MS = 60_000;

/** Thrown when a review session exists but the harness couldn't write its run.json; carries what's needed to settle it. */
export class ReviewRunError extends Error {
  constructor(
    message: string,
    readonly sessionId: string,
    /** The session's cost, or the run's budget when it couldn't be read (worst case). */
    readonly costUsd: number,
  ) {
    super(message);
    this.name = "ReviewRunError";
  }
}

const positiveFinite = (n: number) => typeof n === "number" && Number.isFinite(n) && n > 0;
const MAX_PROBLEM_CHARS = 500;

/**
 * Runs the reviewer on one PR head (ADR-0015, shadow mode). The harness bundles base + head with a read-only
 * token that never reaches the session, copies and mounts screenshots read-only under harness-assigned names,
 * and validates the verdict strictly: an output that doesn't fit ReviewOutputSchema is rejected whole (status
 * invalid_output). Writes run.json (ReviewRunSchema) and leaves the raw review-output.json in outDir.
 *
 * Once a session exists, every exit writes a run.json with its sessionId and cost: a harness error after that
 * point interrupts the session (best effort) and records status `failed`. If even that can't be written, it
 * throws ReviewRunError with the sessionId. Scanning, budgets, the overall verdict and posting are the caller's.
 */
export async function startReview(spec: ReviewSpec, deps: RunDeps): Promise<ReviewRun> {
  // Spec problems are found before anything runs, so they are "not started" too.
  const refuse = (message: string): never => {
    throw new ReviewNotStartedError(message);
  };
  if (!positiveFinite(spec.budgetUsd) || spec.budgetUsd < 0.01) refuse("budgetUsd must be a finite number of at least 0.01");
  if (!positiveFinite(spec.timeoutMinutes)) refuse("timeoutMinutes must be a positive finite number");
  if (spec.hardTimeoutMinutes !== undefined) {
    if (!positiveFinite(spec.hardTimeoutMinutes)) refuse("hardTimeoutMinutes must be a positive finite number");
    if (spec.timeoutMinutes > spec.hardTimeoutMinutes - REVIEW_SETTLE_MARGIN_MINUTES) {
      refuse(`timeoutMinutes must leave ${REVIEW_SETTLE_MARGIN_MINUTES} min before the hard timeout`);
    }
  }
  if (spec.deadlineEpochMs !== undefined && !positiveFinite(spec.deadlineEpochMs)) refuse("deadlineEpochMs must be a positive finite number");
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const progress = { creating: false };
  const notStarted = (err: unknown): never => {
    if (progress.creating || err instanceof ReviewRunError) throw err;
    throw new ReviewNotStartedError(err instanceof Error ? err.message : String(err), { cause: err });
  };
  const shots = await prepareScreenshotMounts(spec.screenshots ?? []).catch(notStarted);
  try {
    return await reviewWithMounts(spec, deps, shots, progress, now, startedAt);
  } catch (err) {
    return notStarted(err);
  } finally {
    await rm(shots.dir, { recursive: true, force: true });
  }
}

async function reviewWithMounts(
  spec: ReviewSpec,
  deps: RunDeps,
  shots: { dir: string; mounts: ScreenshotMount[] },
  progress: { creating: boolean },
  now: () => number,
  startedAt: number,
): Promise<ReviewRun> {
  const marginMs = REVIEW_SETTLE_MARGIN_MINUTES * 60_000;
  {
    const repo = await deps.github.repo(spec.repo);
    if (spec.baseBranch !== repo.default_branch) throw new Error(`PR #${spec.pr} targets ${spec.baseBranch}, not the default branch`);
    const issue = spec.issue === undefined ? undefined : await deps.github.issue(spec.repo, spec.issue);
    const ownerIds = new Set(spec.ownerIds ?? [repo.owner.id]);

    const bundle: ReviewBundle = await (deps.cloneReview ?? createReviewBundle)(
      repo.clone_url,
      { baseBranch: repo.default_branch, pr: spec.pr, headSha: spec.headSha },
      deps.githubToken,
    );
    try {
      if (bundle.headSha !== spec.headSha) throw new Error(`bundled head ${bundle.headSha} is not the requested ${spec.headSha}`);
      const preProblems: string[] = [];
      // The PR's branch point: what its own CI ran with. Never the head, whatever it changes.
      const toolchain = await resolveToolchain(spec.toolchain, bundle.bareDir, bundle.mergeBaseSha, deps.log, preProblems);
      if (spec.deadlineEpochMs !== undefined && now() + MIN_REVIEW_TURN_MS > spec.deadlineEpochMs - marginMs) {
        throw new Error("too little time is left before the review's deadline to open a session");
      }
      deps.log(`review PR #${spec.pr} head ${bundle.headSha.slice(0, 12)} on ${bundle.baseBranch}@${bundle.baseSha.slice(0, 12)}`);
      const session = await openSession(
        deps,
        {
          runId: spec.runId,
          role: "reviewer",
          repo: spec.repo,
          issue: spec.issue ?? null,
          budgetUsd: spec.budgetUsd,
          model: spec.model,
          environment: spec.environment,
          skillDirs: spec.skillDirs,
          review: { pr: spec.pr, headSha: bundle.headSha },
          mounts: shots.mounts,
          progress,
        },
        bundle,
      );

      const base = {
        version: 1 as const,
        kind: "review" as const,
        runId: spec.runId,
        repo: spec.repo,
        pr: spec.pr,
        issue: spec.issue ?? null,
        headSha: bundle.headSha,
        baseSha: bundle.baseSha,
        mergeBaseSha: bundle.mergeBaseSha,
        sessionId: session.sessionId,
        agent: session.agent,
        environmentId: session.environmentId,
        model: session.model,
        screenshots: shots.mounts.map((s) => s.name),
        budgetUsd: spec.budgetUsd,
      };
      const timing = () => ({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(now()).toISOString(),
        wallSeconds: Math.round((now() - startedAt) / 1000),
      });
      const write = async (record: ReviewRun) => {
        ReviewRunSchema.parse(record);
        await mkdir(spec.outDir, { recursive: true });
        await writeFile(join(spec.outDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
        return record;
      };

      try {
        const message = buildReviewTaskMessage({
          repo: spec.repo,
          pr: spec.pr,
          baseBranch: bundle.baseBranch,
          headBranch: bundle.headBranch,
          baseSha: bundle.baseSha,
          headSha: bundle.headSha,
          mergeBaseSha: bundle.mergeBaseSha,
          ownerIds,
          issue,
          prTitle: spec.prTitle,
          prBody: spec.prBody,
          ciSummary: spec.ciSummary,
          screenshots: shots.mounts.map((s) => ({ name: s.name, label: s.label })),
          guidance: spec.guidance,
          toolchain,
        });
        const turn = await runTurn(deps, {
          sessionId: session.sessionId,
          role: "reviewer",
          message,
          priorMessages: 0,
          timeoutMinutes: spec.timeoutMinutes,
          outDir: spec.outDir,
          hardDeadline: spec.deadlineEpochMs === undefined ? undefined : spec.deadlineEpochMs - marginMs,
          interruptDeadline: spec.deadlineEpochMs === undefined ? undefined : spec.deadlineEpochMs - 60_000,
        });

        const raw = turn.files.get(REVIEW_OUTPUT_FILE);
        const check = checkReviewOutput(raw, turn.oversized.has(REVIEW_OUTPUT_FILE));
        const problems = [...preProblems, ...turn.problems];
        // A version mismatch is a note on the run, not a reason to escalate: CI on the head is the judge of record.
        const toolchainRecord = toolchainOutcome(turn.files.has("report.json") ? toolchain : undefined, turn.reportedToolchain, problems);
        if (check.kind === "missing") problems.push(`no ${REVIEW_OUTPUT_FILE}`);
        if (check.kind === "invalid") problems.push(`${REVIEW_OUTPUT_FILE} rejected: it doesn't match the review schema`);
        return await write({
          ...base,
          agent: turn.session.agent,
          environmentId: turn.session.environmentId,
          status: decideReviewStatus(turn.stopReason, check.kind),
          stopReason: turn.stopReason,
          output: check.kind === "valid" ? check.output : null,
          outputIssues: check.kind === "invalid" ? check.issues : [],
          outputBytes: raw?.length ?? null,
          report: turn.report,
          ...(toolchainRecord ? { toolchain: toolchainRecord } : {}),
          ...timing(),
          activeSeconds: turn.session.activeSeconds,
          costUsd: turn.session.costCents / 100,
          problems,
        });
      } catch (err) {
        // The session exists, so this run must still settle: stop it, find out what it cost, and record a failure.
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, MAX_PROBLEM_CHARS);
        deps.log(`review harness error after session ${session.sessionId} opened: ${reason}`);
        await deps.api.interrupt(session.sessionId).catch(() => undefined);
        // Let the interrupt land so the cost is final, but only briefly: the run still has to settle in time.
        // At least a short wait even past deadline - 60 s: the settle margin has room for it.
        const settleMs = deps.settleMs ?? 30_000;
        const settleUntil = Math.max(
          now() + Math.min(settleMs, MIN_INTERRUPT_WAIT_MS),
          Math.min(now() + settleMs, spec.deadlineEpochMs === undefined ? Number.POSITIVE_INFINITY : spec.deadlineEpochMs - 60_000),
        );
        await waitForTurn(deps.api, session.sessionId, { priorMessages: 0, deadline: settleUntil, now, quietMs: 10_000 }).catch(
          () => undefined,
        );
        const info = await deps.api.retrieveSession(session.sessionId).catch(() => undefined);
        // Unknown cost is recorded at the worst case, so the PR's budget ledger never undercounts.
        const costUsd = info ? info.costCents / 100 : spec.budgetUsd;
        try {
          return await write({
            ...base,
            status: "failed",
            stopReason: "harness_error",
            output: null,
            outputIssues: [],
            outputBytes: null,
            ...timing(),
            activeSeconds: info?.activeSeconds ?? null,
            costUsd,
            problems: [...preProblems, `harness error: ${reason}`, ...(info ? [] : ["cost unknown; recorded at budget"])],
          });
        } catch (writeErr) {
          const why = (writeErr instanceof Error ? writeErr.message : String(writeErr)).slice(0, MAX_PROBLEM_CHARS);
          throw new ReviewRunError(`review session ${session.sessionId} failed (${reason}) and its run.json couldn't be written (${why})`, session.sessionId, costUsd);
        }
      }
    } finally {
      await rm(join(bundle.bareDir, ".."), { recursive: true, force: true });
    }
  }
}

/** Continues a finished session with owner feedback (ADR-0011: redirects resume sessions). */
export async function resumeRun(spec: ResumeSpec, deps: RunDeps): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const session = await deps.api.retrieveSession(spec.sessionId);
  if (session.status !== "idle") throw new Error(`session ${spec.sessionId} is ${session.status}, not idle`);
  const meta = session.metadata;
  const role = meta[META.role];
  if (role !== "planner" && role !== "builder") throw new Error(`session ${spec.sessionId} is not a globalhost run`);
  const repoSlug = meta[META.repo] ?? "";
  const issueNumber = Number(meta[META.issue]);
  const baseSha = meta[META.base] ?? "";

  const repo = await deps.github.repo(repoSlug);
  // A fresh clone of the default branch; the original base is an ancestor unless history was rewritten.
  const fresh = await (deps.cloneRepo ?? createRepoBundle)(repo.clone_url, repo.default_branch, deps.githubToken);
  const bundle: RepoBundle = { ...fresh, baseSha };
  try {
    const budgetUsd = session.costCents / 100 + spec.addBudgetUsd;
    await deps.api.setBudget(spec.sessionId, budgetUsd * 100);
    const priorMessages = await countMessages(deps.api, spec.sessionId);
    const branch = role === "builder" ? branchFor(issueNumber) : undefined;
    deps.log(`resuming ${spec.sessionId} (turn ${priorMessages + 1}, budget now $${budgetUsd.toFixed(2)})`);
    // The same versions as the first turn: resolved at the stored base (in the fresh clone unless history was rewritten).
    const preProblems: string[] = [];
    const toolchain = await resolveToolchain(spec.toolchain, fresh.bareDir, baseSha, deps.log, preProblems);
    return await driveTurn(deps, {
      runId: meta[META.run] ?? spec.sessionId,
      role,
      repo: repoSlug,
      issue: issueNumber,
      sessionId: spec.sessionId,
      bundle,
      model: meta[META.model] ?? "",
      message: buildFeedbackMessage({ role, branch, baseSha }, spec.feedback),
      priorMessages,
      budgetUsd,
      timeoutMinutes: spec.timeoutMinutes,
      outDir: spec.outDir,
      startedAt,
      toolchain,
      preProblems,
    });
  } finally {
    await rm(join(fresh.bareDir, ".."), { recursive: true, force: true });
  }
}

interface Turn {
  runId: string;
  role: Exclude<RoleId, "reviewer">;
  repo: string;
  issue: number | null;
  sessionId: string;
  bundle: RepoBundle;
  model: string;
  message: string;
  priorMessages: number;
  budgetUsd: number;
  timeoutMinutes: number;
  outDir: string;
  startedAt: number;
  /** Required tool versions (from the base commit), when the caller resolved them. */
  toolchain?: Toolchain;
  /** Problems found before the session ran (e.g. the toolchain couldn't be resolved). */
  preProblems?: string[];
}

interface TurnResult {
  stopReason: string;
  session: Awaited<ReturnType<ManagedAgentsApi["retrieveSession"]>>;
  files: Map<string, Buffer>;
  /** Accepted outputs the session wrote over their size cap (not downloaded). */
  oversized: Set<string>;
  report: AgentReport | undefined;
  /** report.json's raw `toolchain` value (untrusted), for checkToolchain; undefined when absent. */
  reportedToolchain: unknown;
  problems: string[];
}

/** Sends the message, waits for the turn (interrupting at the deadline), and collects the role's outputs. */
async function runTurn(
  deps: RunDeps,
  t: {
    sessionId: string;
    role: RoleId;
    message: string;
    priorMessages: number;
    timeoutMinutes: number;
    outDir: string;
    /** Absolute cap on the turn (epoch ms), whatever timeoutMinutes says. */
    hardDeadline?: number;
    /** Absolute cap on the wait for an interrupt to land. */
    interruptDeadline?: number;
  },
): Promise<TurnResult> {
  const now = deps.now ?? Date.now;
  const sentAt = now();
  await deps.api.sendMessage(t.sessionId, t.message);
  const deadline = Math.min(sentAt + t.timeoutMinutes * 60_000, t.hardDeadline ?? Number.POSITIVE_INFINITY);
  let wait = await waitForTurn(deps.api, t.sessionId, {
    priorMessages: t.priorMessages,
    deadline,
    onEvent: deps.onEvent,
    now,
    // With a hard deadline, check it more often than the default minute of quiet.
    ...(t.hardDeadline === undefined ? {} : { quietMs: 30_000 }),
  });
  if (wait.reconnects > 0) deps.log(`event stream reconnected ${wait.reconnects} time(s)`);
  if (wait.stopReason === "timeout") {
    deps.log(`timed out after ${Math.round((now() - sentAt) / 60_000)} min; interrupting`);
    await deps.api.interrupt(t.sessionId).catch(() => undefined);
    // Give the interrupt a moment to land so outputs and cost are final; the status stays "timeout".
    // At least MIN_INTERRUPT_WAIT_MS even past the interrupt deadline: the settle margin has room for it.
    const until = Math.max(now() + MIN_INTERRUPT_WAIT_MS, Math.min(now() + 120_000, t.interruptDeadline ?? Number.POSITIVE_INFINITY));
    await waitForTurn(deps.api, t.sessionId, { priorMessages: t.priorMessages, deadline: until, now, ...(t.interruptDeadline === undefined ? {} : { quietMs: 10_000 }) });
    wait = { ...wait, stopReason: "timeout" };
  }

  let session = await deps.api.retrieveSession(t.sessionId);
  await mkdir(t.outDir, { recursive: true });
  const problems: string[] = [];
  const oversized = new Set<string>();
  const files = await collectOutputs(
    deps.api,
    t.sessionId,
    t.outDir,
    ROLE_OUTPUTS[t.role],
    t.priorMessages > 0 ? sentAt - CLOCK_SKEW_MS : 0,
    problems,
    oversized,
  );

  let report: AgentReport | undefined;
  let reportedToolchain: unknown;
  if (files.has("report.json")) {
    try {
      const raw: unknown = JSON.parse(files.get("report.json")!.toString("utf8"));
      // Read before the schema check, so the versions are compared even when another field fails it.
      if (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "toolchain")) reportedToolchain = (raw as { toolchain: unknown }).toolchain;
      report = AgentReportSchema.parse(raw);
    } catch {
      problems.push("report.json is not valid JSON in the expected shape");
    }
  } else problems.push("no report.json");
  // The cost can still rise while outputs are collected (an interrupt landing late): keep the larger reading.
  const later = await deps.api.retrieveSession(t.sessionId).catch(() => undefined);
  if (later && later.costCents > session.costCents) session = { ...session, costCents: later.costCents };
  return { stopReason: wait.stopReason, session, files, oversized, report, reportedToolchain, problems };
}

async function driveTurn(deps: RunDeps, turn: Turn): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const { stopReason, session, files, report, reportedToolchain, problems: turnProblems } = await runTurn(deps, turn);
  const problems = [...(turn.preProblems ?? []), ...turnProblems];
  // Checked only when the turn wrote a report; a missing report is already a problem of its own.
  const toolchain = toolchainOutcome(files.has("report.json") ? turn.toolchain : undefined, reportedToolchain, problems);

  const outputs: RunRecord["outputs"] = {};
  if (turn.role === "builder" && files.has("result.bundle")) {
    try {
      outputs.bundle = await inspectResultBundle(
        turn.bundle.bareDir,
        join(turn.outDir, "result.bundle"),
        turn.bundle.baseSha,
        branchFor(turn.issue ?? 0),
      );
    } catch (err) {
      problems.push(`result.bundle rejected: ${(err as Error).message}`);
      await rm(join(turn.outDir, "result.bundle"), { force: true });
    }
  } else if (turn.role === "builder") problems.push("no result.bundle");
  if (turn.role === "planner") {
    if (files.has("plan.md")) outputs.planBytes = files.get("plan.md")!.length;
    else problems.push("no plan.md");
  }
  if (turn.role === "assessor") {
    if (files.has("assessment.md")) outputs.assessmentBytes = files.get("assessment.md")!.length;
    else problems.push("no assessment.md");
    if (files.has("factory.yaml")) outputs.factoryYamlBytes = files.get("factory.yaml")!.length;
  }

  const record: RunRecord = {
    version: 1,
    runId: turn.runId,
    role: turn.role,
    repo: turn.repo,
    issue: turn.issue,
    baseSha: turn.bundle.baseSha,
    sessionId: turn.sessionId,
    agent: session.agent,
    environmentId: session.environmentId,
    model: turn.model,
    turn: turn.priorMessages + 1,
    status: decideStatus(turn.role, stopReason, report, outputs),
    stopReason,
    startedAt: new Date(turn.startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    wallSeconds: Math.round((now() - turn.startedAt) / 1000),
    activeSeconds: session.activeSeconds,
    costUsd: session.costCents / 100,
    budgetUsd: turn.budgetUsd,
    outputs,
    report,
    ...(toolchain ? { toolchain } : {}),
    problems,
  };
  RunRecordSchema.parse(record);
  await writeFile(join(turn.outDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function decideStatus(
  role: Exclude<RoleId, "reviewer">,
  stopReason: string,
  report: AgentReport | undefined,
  outputs: RunRecord["outputs"],
): RunStatus {
  if (stopReason === "budget_reached") return "cap_exceeded";
  if (stopReason === "timeout") return "timeout";
  if (stopReason !== "end_turn") return "failed";
  if (report?.outcome === "blocked") return "blocked";
  if (report?.outcome !== "done") return "failed";
  if (role === "builder") return outputs.bundle ? "succeeded" : "failed";
  if (role === "assessor") return outputs.assessmentBytes ? "succeeded" : "failed";
  return outputs.planBytes ? "succeeded" : "failed";
}

/** Downloads the newest copy of each accepted output, within its size cap, into outDir. */
async function collectOutputs(
  api: ManagedAgentsApi,
  sessionId: string,
  outDir: string,
  accepted: readonly string[],
  notBefore: number,
  problems: string[],
  oversized: Set<string>,
): Promise<Map<string, Buffer>> {
  let listed: OutputFile[] = [];
  // Outputs can take a moment to appear after the session idles.
  for (let attempt = 0; attempt < 5 && listed.length === 0; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2_000));
    listed = await api.listOutputFiles(sessionId);
  }
  const newest = new Map<string, OutputFile>();
  for (const f of listed) {
    if (Date.parse(f.createdAt) < notBefore) continue;
    const prev = newest.get(f.filename);
    if (!prev || prev.createdAt < f.createdAt) newest.set(f.filename, f);
  }

  const files = new Map<string, Buffer>();
  let screenshots = 0;
  for (const [name, f] of newest) {
    const limit = (accepted.includes(name) ? OUTPUT_LIMITS[name] : undefined) ?? (SCREENSHOT_RE.test(name) ? SCREENSHOT_LIMIT : undefined);
    if (limit === undefined) continue;
    if (limit === SCREENSHOT_LIMIT && ++screenshots > MAX_SCREENSHOTS) continue;
    if (f.sizeBytes > limit) {
      problems.push(`${name} is ${f.sizeBytes} bytes (limit ${limit}); ignored`);
      oversized.add(name);
      continue;
    }
    const data = await api.downloadFile(f.id);
    if (data.length > limit) {
      problems.push(`${name} downloaded larger than its limit; ignored`);
      oversized.add(name);
      continue;
    }
    files.set(name, data);
    await writeFile(join(outDir, name), data);
  }
  return files;
}
