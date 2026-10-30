// `globalhost run` and `globalhost roles sync`: drive the runner harness from the owner's machine
// (PLAN P1-06). Auth is keyless (ADR-0014): the owner's gcloud login mints an identity token for the
// local-runs service account, which a Console federation rule exchanges for an Anthropic token.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseFactoryYaml, validateFactoryConfig, type FactoryConfig } from "@globalhost/core";
import { GitHubClient, githubSnapshot, profileRunSettings, type RunSettings } from "@globalhost/dispatch";
import { ROLE_IDS, definitionHash, roleDefinition, type RoleId } from "@globalhost/roles";
import {
  GitHubReader,
  anthropicClient,
  ensureAgent,
  ensureSkill,
  federationIdsFromEnv,
  googleImpersonatedIdentity,
  parseRepo,
  resumeRun,
  sdkApi,
  startRun,
  type ManagedAgentsApi,
  type RunRecord,
  type SessionEvent,
} from "@globalhost/runner";
import { PROFILES, SKILL_DIRS, defaultDeps, printable } from "./main.js";

export const RUN_USAGE = `Usage:
  globalhost run <owner/repo> <issue> --role <planner|builder> [options]
  globalhost run --resume <session-id> (--feedback <text> | --feedback-file <path>) [options]
  globalhost roles sync

Options:
  --budget <usd>        Session budget (default 4; with --resume, added to what's spent; default 2)
  --timeout <minutes>   Wall-clock limit for this turn (default 45)
  --model <id>          Model for the role's agent (default: the role's default)
  --plan-file <path>    Builder: an approved plan to start from
  --config <path>       A factory.yaml for the repo (e.g. a draft before it's committed): its parts' profile
                        guidance and network environment are used, and its owners unless --owner-id is given
  --owner-id <id>       Owner GitHub user ID; repeatable (default: the repo owner's account)
  --out <dir>           Where outputs go (default .globalhost/runs/<run-id>)
  --verbose             Also print the agent's messages

Environment:
  GLOBALHOST_LOCAL_SA            Service account the owner impersonates for local runs
  ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_FEDERATION_RULE_ID,
  ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_WORKSPACE_ID   Federation rule IDs (not secrets)
  GITHUB_TOKEN                   Optional read-only token, for private repos`;

export interface RunIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Test seams: default to the real SDK with keyless auth, GitHub, and the registered profiles' skills. */
  api?: ManagedAgentsApi;
  github?: GitHubReader;
  fetchImpl?: typeof fetch;
  skillDirs?: readonly string[];
}

class UsageError extends Error {}

function positiveNumber(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new UsageError(`--${name} must be a number in (0, ${max}]`);
  return n;
}

function makeApi(io: RunIo): ManagedAgentsApi {
  if (io.api) return io.api;
  const sa = io.env.GLOBALHOST_LOCAL_SA;
  if (!sa) throw new UsageError("GLOBALHOST_LOCAL_SA is not set (see packages/runner/README.md)");
  return sdkApi(anthropicClient(federationIdsFromEnv(io.env), googleImpersonatedIdentity(sa)));
}

function runId(role: string, issue: number): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${role}-${issue}-${randomBytes(3).toString("hex")}`;
}

function eventPrinter(io: RunIo, verbose: boolean): (e: SessionEvent) => void {
  return (e) => {
    if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") io.err(`  · ${printable(e.toolName ?? "tool")}\n`);
    else if (e.type === "session.status_idle") io.err(`  · idle (${printable(e.stopReason ?? "")})\n`);
    else if (e.type === "agent.message" && verbose && e.text) {
      // Escape per line so the message keeps its line breaks but can't drive the terminal.
      io.err(`\n${e.text.slice(0, 2000).split("\n").map(printable).join("\n")}\n\n`);
    }
  };
}

function summary(record: RunRecord, outDir: string): string {
  const lines = [
    "",
    `status    ${record.status} (${record.stopReason})`,
    `cost      $${record.costUsd.toFixed(2)} of $${record.budgetUsd.toFixed(2)}, ${record.wallSeconds}s wall, turn ${record.turn}`,
    `session   ${record.sessionId}`,
    `outputs   ${outDir}`,
  ];
  if (record.report) lines.push(`summary   ${printable(record.report.summary)}`);
  for (const q of record.report?.questions ?? []) lines.push(`question  ${printable(q)}`);
  const bundle = record.outputs.bundle;
  if (bundle) {
    lines.push(
      `bundle    ${bundle.commits} commit(s), ${bundle.filesChanged.length} file(s): ${bundle.filesChanged.map(printable).join(", ")}`,
      `apply     git fetch ${join(outDir, "result.bundle")} ${bundle.branch}:${bundle.branch}`,
    );
  }
  if (record.outputs.planBytes) lines.push(`plan      ${join(outDir, "plan.md")}`);
  for (const p of record.problems) lines.push(`problem   ${printable(p)}`);
  lines.push(`resume    globalhost run --resume ${record.sessionId} --feedback "…"`);
  return `${lines.join("\n")}\n`;
}

export async function runCommand(argv: readonly string[], io: RunIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(`${RUN_USAGE}\n`);
    return 0;
  }
  try {
    if (argv[0] === "roles") return await rolesCommand(argv.slice(1), io);
    const { values, positionals } = parseArgs({
      args: [...argv.slice(1)],
      options: {
        role: { type: "string" },
        budget: { type: "string" },
        timeout: { type: "string" },
        model: { type: "string" },
        "plan-file": { type: "string" },
        config: { type: "string" },
        "owner-id": { type: "string", multiple: true },
        out: { type: "string" },
        resume: { type: "string" },
        feedback: { type: "string" },
        "feedback-file": { type: "string" },
        verbose: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const timeoutMinutes = positiveNumber("timeout", values.timeout, 45, 240);
    const deps = {
      api: makeApi(io),
      github: io.github ?? new GitHubReader(io.env.GITHUB_TOKEN || undefined),
      githubToken: io.env.GITHUB_TOKEN || undefined,
      log: (line: string) => io.err(`${printable(line)}\n`),
      onEvent: eventPrinter(io, values.verbose ?? false),
    };

    let record: RunRecord;
    let outDir: string;
    if (values.resume) {
      if (positionals.length > 0) throw new UsageError("--resume takes no positional arguments");
      const feedback = values["feedback-file"] ? await readFile(values["feedback-file"], "utf8") : values.feedback;
      if (!feedback?.trim()) throw new UsageError("--resume needs --feedback or --feedback-file");
      if (!/^sesn_[A-Za-z0-9]+$/.test(values.resume)) throw new UsageError("--resume needs a session ID (sesn_…)");
      outDir = resolve(io.cwd, values.out ?? join(".globalhost", "runs", `${values.resume}-${Date.now()}`));
      record = await resumeRun(
        {
          sessionId: values.resume,
          feedback,
          addBudgetUsd: positiveNumber("budget", values.budget, 2, 50),
          timeoutMinutes,
          outDir,
        },
        deps,
      );
    } else {
      const [repo, issueRaw] = positionals;
      if (!repo || !issueRaw || positionals.length > 2) throw new UsageError("expected <owner/repo> <issue>");
      try {
        parseRepo(repo);
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
      const issue = Number(issueRaw);
      if (!Number.isSafeInteger(issue) || issue < 1) throw new UsageError("issue must be a positive integer");
      const role = values.role as RoleId;
      if (!ROLE_IDS.includes(role)) throw new UsageError(`--role must be one of ${ROLE_IDS.join(", ")}`);
      const settings = values.config ? await localSettings(io, resolve(io.cwd, values.config), repo) : undefined;
      const ownerIds = values["owner-id"]?.map((raw) => {
        const id = Number(raw);
        if (!Number.isSafeInteger(id) || id < 1) throw new UsageError("--owner-id must be a GitHub user ID");
        return id;
      });
      const id = runId(role, issue);
      outDir = resolve(io.cwd, values.out ?? join(".globalhost", "runs", id));
      record = await startRun(
        {
          runId: id,
          role,
          repo,
          issue,
          budgetUsd: positiveNumber("budget", values.budget, 4, 50),
          timeoutMinutes,
          outDir,
          model: values.model,
          ownerIds: ownerIds ?? settings?.config.owners.map((o) => o.id),
          guidance: settings?.run.guidance,
          environment: settings?.run.environment,
          skillDirs: [...(io.skillDirs ?? SKILL_DIRS)],
          approvedPlan: values["plan-file"] ? await readFile(values["plan-file"], "utf8") : undefined,
        },
        deps,
      );
    }
    io.out(summary(record, outDir));
    return record.status === "succeeded" ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`${printable((err as Error).message)}\n\n${RUN_USAGE}\n`);
      return 2;
    }
    io.err(`error: ${printable((err as Error).message)}\n`);
    return 1;
  }
}

/** The same profile settings the dispatcher builds, from a local factory.yaml and the repo's default branch. */
async function localSettings(io: RunIo, path: string, repo: string): Promise<{ config: FactoryConfig; run: RunSettings }> {
  const parsed = parseFactoryYaml(await readFile(path));
  if (!parsed.ok) throw new UsageError(`${path}: ${parsed.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const result = validateFactoryConfig(parsed.value, defaultDeps().registry);
  if (!result.ok) throw new UsageError(`${path}: ${result.errors.map((e) => `${e.path || "(root)"} ${e.message}`).join("; ")}`);
  const gh = new GitHubClient(io.env.GITHUB_TOKEN || undefined, io.fetchImpl);
  const snapshot = await githubSnapshot(gh, repo, result.config.git.defaultBranch);
  return { config: result.config, run: await profileRunSettings(PROFILES, result.config, snapshot) };
}

async function rolesCommand(argv: readonly string[], io: RunIo): Promise<number> {
  if (argv[0] !== "sync" || argv.length > 1) throw new UsageError("expected: globalhost roles sync");
  const api = makeApi(io);
  const skills = [];
  for (const dir of io.skillDirs ?? SKILL_DIRS) skills.push(await ensureSkill(api, dir));
  for (const id of ROLE_IDS) {
    const def = roleDefinition(id, undefined, skills);
    const agent = await ensureAgent(api, def, definitionHash(def));
    io.out(`${def.agentName}  ${agent.id}  v${agent.version}\n`);
  }
  return 0;
}
