// The harness: drive one role's session for one issue and turn its outputs into a trusted run.json.
// It's host-specific (RunnerHost = Managed Agents here, ADR-0011) but publishing is not: the dispatcher
// (P1-07) and `globalhost run` both call these functions and then decide what to do with the record.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definitionHash, roleDefinition, type RoleId } from "@globalhost/roles";
import { createRepoBundle, inspectResultBundle, type RepoBundle } from "./git.js";
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
import { REPO_BUNDLE_MOUNT, buildFeedbackMessage, buildTaskMessage } from "./prompt.js";
import { AgentReportSchema, RunRecordSchema, type AgentReport, type RunRecord, type RunStatus } from "./records.js";

export const DEFAULT_ENVIRONMENT: EnvironmentSpec = { name: "globalhost-default", allowedHosts: [] };

/** Output files the harness accepts, with size caps. Anything else the agent writes is ignored. */
const OUTPUT_LIMITS: Record<string, number> = {
  "report.json": 256 * 1024,
  "plan.md": 256 * 1024,
  "result.bundle": 100 * 1024 * 1024,
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
} as const;

export async function startRun(spec: StartSpec, deps: RunDeps): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const repo = await deps.github.repo(spec.repo);
  const issue = await deps.github.issue(spec.repo, spec.issue);
  const ownerIds = new Set(spec.ownerIds ?? [repo.owner.id]);
  if (!ownerIds.has(issue.author.id)) deps.log(`note: issue #${spec.issue} wasn't opened by an owner; its text is fenced as data`);

  const bundle = await (deps.cloneRepo ?? createRepoBundle)(repo.clone_url, repo.default_branch, deps.githubToken);
  try {
    deps.log(`base ${repo.default_branch}@${bundle.baseSha.slice(0, 12)}`);
    const skills = [];
    for (const dir of spec.skillDirs ?? []) skills.push(await ensureSkill(deps.api, dir));
    const def = roleDefinition(spec.role, spec.model, skills);
    const agent = await ensureAgent(deps.api, def, definitionHash(def));
    const environmentId = await ensureEnvironment(deps.api, spec.environment ?? DEFAULT_ENVIRONMENT);
    const fileId = await deps.api.uploadFile(bundle.bundlePath);

    const sessionId = await deps.api.createSession({
      agent,
      environmentId,
      budgetCents: spec.budgetUsd * 100,
      title: `${spec.repo}#${spec.issue} ${spec.role}`,
      metadata: {
        [META.run]: spec.runId,
        [META.repo]: spec.repo,
        [META.issue]: String(spec.issue),
        [META.role]: spec.role,
        [META.base]: bundle.baseSha,
        [META.budget]: String(spec.budgetUsd),
        [META.model]: def.model,
      },
      files: [{ fileId, mountPath: REPO_BUNDLE_MOUNT }],
    });
    deps.log(`session ${sessionId} (agent ${def.agentName} v${agent.version}, budget $${spec.budgetUsd})`);

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
      model: def.model,
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
  role: RoleId;
  repo: string;
  issue: number;
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

async function driveTurn(deps: RunDeps, turn: Turn): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const sentAt = now();
  await deps.api.sendMessage(turn.sessionId, turn.message);
  const deadline = sentAt + turn.timeoutMinutes * 60_000;
  let wait = await waitForTurn(deps.api, turn.sessionId, {
    priorMessages: turn.priorMessages,
    deadline,
    onEvent: deps.onEvent,
    now,
  });
  if (wait.reconnects > 0) deps.log(`event stream reconnected ${wait.reconnects} time(s)`);
  if (wait.stopReason === "timeout") {
    deps.log(`timed out after ${turn.timeoutMinutes} min; interrupting`);
    await deps.api.interrupt(turn.sessionId).catch(() => undefined);
    // Give the interrupt a moment to land so outputs and cost are final; the status stays "timeout".
    await waitForTurn(deps.api, turn.sessionId, { priorMessages: turn.priorMessages, deadline: now() + 120_000, now });
    wait = { ...wait, stopReason: "timeout" };
  }

  const session = await deps.api.retrieveSession(turn.sessionId);
  await mkdir(turn.outDir, { recursive: true });
  const problems: string[] = [];
  const files = await collectOutputs(deps.api, turn.sessionId, turn.outDir, turn.priorMessages > 0 ? sentAt - CLOCK_SKEW_MS : 0, problems);

  let report: AgentReport | undefined;
  if (files.has("report.json")) {
    try {
      report = AgentReportSchema.parse(JSON.parse(files.get("report.json")!.toString("utf8")));
    } catch {
      problems.push("report.json is not valid JSON in the expected shape");
    }
  } else problems.push("no report.json");

  const outputs: RunRecord["outputs"] = {};
  if (turn.role === "builder" && files.has("result.bundle")) {
    try {
      outputs.bundle = await inspectResultBundle(
        turn.bundle.bareDir,
        join(turn.outDir, "result.bundle"),
        turn.bundle.baseSha,
        branchFor(turn.issue),
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
    status: decideStatus(turn.role, wait.stopReason, report, outputs),
    stopReason: wait.stopReason,
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
  role: RoleId,
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
  return outputs.planBytes ? "succeeded" : "failed";
}

/** Downloads the newest copy of each accepted output, within its size cap, into outDir. */
async function collectOutputs(
  api: ManagedAgentsApi,
  sessionId: string,
  outDir: string,
  notBefore: number,
  problems: string[],
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
    const limit = OUTPUT_LIMITS[name] ?? (SCREENSHOT_RE.test(name) ? SCREENSHOT_LIMIT : undefined);
    if (limit === undefined) continue;
    if (limit === SCREENSHOT_LIMIT && ++screenshots > MAX_SCREENSHOTS) continue;
    if (f.sizeBytes > limit) {
      problems.push(`${name} is ${f.sizeBytes} bytes (limit ${limit}); ignored`);
      continue;
    }
    const data = await api.downloadFile(f.id);
    if (data.length > limit) {
      problems.push(`${name} downloaded larger than its limit; ignored`);
      continue;
    }
    files.set(name, data);
    await writeFile(join(outDir, name), data);
  }
  return files;
}
