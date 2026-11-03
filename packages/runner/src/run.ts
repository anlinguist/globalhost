// The harness: drive one role's session for one issue and turn its outputs into a trusted run.json.
// It's host-specific (RunnerHost = Managed Agents here, ADR-0011) but publishing is not: the dispatcher
// (P1-07) and `globalhost run` both call these functions and then decide what to do with the record.
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { parseReviewOutput, type ReviewOutput, type ReviewOutputIssue, type ReviewStatus } from "@globalhost/core";
import { REVIEW_OUTPUT_FILE, definitionHash, roleDefinition, type RoleId } from "@globalhost/roles";
import { createRepoBundle, createReviewBundle, inspectResultBundle, type RepoBundle, type ReviewBundle } from "./git.js";
import { ensureSkill } from "./skills.js";
import type { GitHubReader } from "./github.js";
import {
  countMessages,
  ensureAgent,
  ensureEnvironment,
  waitForTurn,
  type EnvironmentSpec,
  type ManagedAgentsApi,
  type OutputFile,
  type SessionEvent,
} from "./managed-agents.js";
import {
  REPO_BUNDLE_MOUNT,
  SCREENSHOT_MOUNT_DIR,
  SCREENSHOT_NAME,
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
  /** Test seam for bundling a PR for review; defaults to createReviewBundle. */
  cloneReview?: typeof createReviewBundle;
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
}

export interface ResumeSpec {
  sessionId: string;
  feedback: string;
  /** Added on top of what the session has spent so far. */
  addBudgetUsd: number;
  timeoutMinutes: number;
  outDir: string;
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
}

/** Syncs the role's agent (with its pinned skills) and environment, uploads the bundle, and opens the session. */
async function openSession(deps: RunDeps, l: SessionLaunch, bundle: RepoBundle): Promise<{ sessionId: string; model: string }> {
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
  const sessionId = await deps.api.createSession({
    agent,
    environmentId,
    budgetCents: l.budgetUsd * 100,
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
  return { sessionId, model: def.model };
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
  /** Name to mount it under; defaults to the file's basename. Must match SCREENSHOT_NAME. */
  name?: string;
}

export interface ScreenshotMount {
  name: string;
  localPath: string;
  /** Under SCREENSHOT_MOUNT_DIR, relative to the session's uploads root. */
  mountPath: string;
}

export const MAX_REVIEW_SCREENSHOTS = MAX_SCREENSHOTS;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Checks screenshots before mounting them: a plain `.png` name that stays directly under SCREENSHOT_MOUNT_DIR,
 * no duplicates (case-insensitively), a regular file (not a symlink) within the size cap that starts like a PNG.
 * Throws on the first problem; a review with a bad screenshot input is a harness bug, not something to skip.
 */
export async function prepareScreenshotMounts(inputs: readonly ScreenshotInput[]): Promise<ScreenshotMount[]> {
  if (inputs.length > MAX_REVIEW_SCREENSHOTS) throw new Error(`too many screenshots (${inputs.length}, max ${MAX_REVIEW_SCREENSHOTS})`);
  const seen = new Set<string>();
  const mounts: ScreenshotMount[] = [];
  for (const input of inputs) {
    const name = input.name ?? basename(input.path);
    if (!SCREENSHOT_NAME.test(name)) throw new Error(`bad screenshot name: ${JSON.stringify(name.slice(0, 100))}`);
    const mountPath = posix.join(SCREENSHOT_MOUNT_DIR, name);
    if (posix.dirname(mountPath) !== SCREENSHOT_MOUNT_DIR || posix.basename(mountPath) !== name) {
      throw new Error(`screenshot ${name} would mount outside ${SCREENSHOT_MOUNT_DIR}`);
    }
    if (seen.has(name.toLowerCase())) throw new Error(`duplicate screenshot name: ${name}`);
    seen.add(name.toLowerCase());

    const st = await lstat(input.path);
    if (!st.isFile()) throw new Error(`screenshot ${name} is not a regular file`);
    if (st.size === 0 || st.size > SCREENSHOT_LIMIT) throw new Error(`screenshot ${name} is ${st.size} bytes (limit ${SCREENSHOT_LIMIT})`);
    const fh = await open(input.path, "r");
    try {
      const head = Buffer.alloc(PNG_MAGIC.length);
      await fh.read(head, 0, head.length, 0);
      if (!head.equals(PNG_MAGIC)) throw new Error(`screenshot ${name} is not a PNG`);
    } finally {
      await fh.close();
    }
    mounts.push({ name, localPath: input.path, mountPath });
  }
  return mounts;
}

export interface ReviewSpec {
  runId: string;
  repo: string;
  pr: number;
  /** The head to review (from the CI run or the PR event); the review is refused if the PR has moved. */
  headSha: string;
  /** The PR's base branch. */
  baseBranch: string;
  /** The issue the PR implements (factory/issue-<n>); its title and body are the spec, fenced. */
  issue?: number;
  /** PR title and description (builder-written; fenced). */
  prTitle?: string;
  prBody?: string;
  /** The caller's summary of the CI run on this head (fenced). */
  ciSummary?: string;
  /** Preview screenshots as local files, mounted read-only under SCREENSHOT_MOUNT_DIR. */
  screenshots?: readonly ScreenshotInput[];
  budgetUsd: number;
  timeoutMinutes: number;
  outDir: string;
  /** Defaults to the builder's pinned model (DEFAULT_MODEL). */
  model?: string;
  environment?: EnvironmentSpec;
  skillDirs?: string[];
  ownerIds?: number[];
  guidance?: string;
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
 * Parses the reviewer's raw output file: strict UTF-8, exactly one JSON value, then core's parseReviewOutput.
 * Never clips or repairs. Issues use fixed text so nothing the reviewer wrote is echoed into the record.
 */
export function checkReviewOutput(raw: Buffer | undefined, oversized: boolean): ReviewOutputCheck {
  if (oversized) return { kind: "invalid", issues: [{ path: "", code: "too_big", message: "output file over its size limit" }] };
  if (raw === undefined) return { kind: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return { kind: "invalid", issues: [{ path: "", code: "invalid_json", message: "not a single JSON value in UTF-8" }] };
  }
  const parsed = parseReviewOutput(value);
  return parsed.ok ? { kind: "valid", output: parsed.output } : { kind: "invalid", issues: parsed.issues };
}

/**
 * Runs the reviewer on one PR head (ADR-0015, shadow mode). The harness bundles base + head with a read-only
 * token that never reaches the session, mounts screenshots read-only, and validates the verdict strictly:
 * an output that doesn't fit ReviewOutputSchema is rejected whole (status invalid_output). Writes run.json
 * (ReviewRunSchema) and leaves the raw review-output.json in outDir. Scanning, budgets, the overall verdict
 * and posting are the caller's.
 */
export async function startReview(spec: ReviewSpec, deps: RunDeps): Promise<ReviewRun> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const screenshots = await prepareScreenshotMounts(spec.screenshots ?? []);
  const repo = await deps.github.repo(spec.repo);
  const issue = spec.issue === undefined ? undefined : await deps.github.issue(spec.repo, spec.issue);
  const ownerIds = new Set(spec.ownerIds ?? [repo.owner.id]);

  const bundle: ReviewBundle = await (deps.cloneReview ?? createReviewBundle)(
    repo.clone_url,
    { baseBranch: spec.baseBranch, pr: spec.pr, headSha: spec.headSha },
    deps.githubToken,
  );
  try {
    if (bundle.headSha !== spec.headSha) throw new Error(`bundled head ${bundle.headSha} is not the requested ${spec.headSha}`);
    deps.log(`review PR #${spec.pr} head ${bundle.headSha.slice(0, 12)} on ${bundle.baseBranch}@${bundle.baseSha.slice(0, 12)}`);
    const { sessionId, model } = await openSession(
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
        mounts: screenshots,
      },
      bundle,
    );
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
      screenshots: screenshots.map((s) => s.name),
      guidance: spec.guidance,
    });
    const turn = await runTurn(deps, {
      sessionId,
      role: "reviewer",
      message,
      priorMessages: 0,
      timeoutMinutes: spec.timeoutMinutes,
      outDir: spec.outDir,
    });

    const raw = turn.files.get(REVIEW_OUTPUT_FILE);
    const check = checkReviewOutput(raw, turn.oversized.has(REVIEW_OUTPUT_FILE));
    const problems = [...turn.problems];
    if (check.kind === "missing") problems.push(`no ${REVIEW_OUTPUT_FILE}`);
    if (check.kind === "invalid") problems.push(`${REVIEW_OUTPUT_FILE} rejected: it doesn't match the review schema`);

    const record: ReviewRun = {
      version: 1,
      kind: "review",
      runId: spec.runId,
      repo: spec.repo,
      pr: spec.pr,
      issue: spec.issue ?? null,
      headSha: bundle.headSha,
      baseSha: bundle.baseSha,
      mergeBaseSha: bundle.mergeBaseSha,
      sessionId,
      agent: turn.session.agent,
      environmentId: turn.session.environmentId,
      model,
      status: decideReviewStatus(turn.stopReason, check.kind),
      stopReason: turn.stopReason,
      output: check.kind === "valid" ? check.output : null,
      outputIssues: check.kind === "invalid" ? check.issues : [],
      outputBytes: raw?.length ?? null,
      screenshots: screenshots.map((s) => s.name),
      report: turn.report,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      wallSeconds: Math.round((now() - startedAt) / 1000),
      activeSeconds: turn.session.activeSeconds,
      costUsd: turn.session.costCents / 100,
      budgetUsd: spec.budgetUsd,
      problems,
    };
    ReviewRunSchema.parse(record);
    await writeFile(join(spec.outDir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    await rm(join(bundle.bareDir, ".."), { recursive: true, force: true });
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
}

interface TurnResult {
  stopReason: string;
  session: Awaited<ReturnType<ManagedAgentsApi["retrieveSession"]>>;
  files: Map<string, Buffer>;
  /** Accepted outputs the session wrote over their size cap (not downloaded). */
  oversized: Set<string>;
  report: AgentReport | undefined;
  problems: string[];
}

/** Sends the message, waits for the turn (interrupting at the deadline), and collects the role's outputs. */
async function runTurn(
  deps: RunDeps,
  t: { sessionId: string; role: RoleId; message: string; priorMessages: number; timeoutMinutes: number; outDir: string },
): Promise<TurnResult> {
  const now = deps.now ?? Date.now;
  const sentAt = now();
  await deps.api.sendMessage(t.sessionId, t.message);
  const deadline = sentAt + t.timeoutMinutes * 60_000;
  let wait = await waitForTurn(deps.api, t.sessionId, {
    priorMessages: t.priorMessages,
    deadline,
    onEvent: deps.onEvent,
    now,
  });
  if (wait.reconnects > 0) deps.log(`event stream reconnected ${wait.reconnects} time(s)`);
  if (wait.stopReason === "timeout") {
    deps.log(`timed out after ${t.timeoutMinutes} min; interrupting`);
    await deps.api.interrupt(t.sessionId).catch(() => undefined);
    // Give the interrupt a moment to land so outputs and cost are final; the status stays "timeout".
    await waitForTurn(deps.api, t.sessionId, { priorMessages: t.priorMessages, deadline: now() + 120_000, now });
    wait = { ...wait, stopReason: "timeout" };
  }

  const session = await deps.api.retrieveSession(t.sessionId);
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
  if (files.has("report.json")) {
    try {
      report = AgentReportSchema.parse(JSON.parse(files.get("report.json")!.toString("utf8")));
    } catch {
      problems.push("report.json is not valid JSON in the expected shape");
    }
  } else problems.push("no report.json");
  return { stopReason: wait.stopReason, session, files, oversized, report, problems };
}

async function driveTurn(deps: RunDeps, turn: Turn): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const { stopReason, session, files, report, problems } = await runTurn(deps, turn);

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
