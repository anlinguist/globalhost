// The two steps of the installed workflow (templates/.github/workflows/globalhost.yml):
//   gate      no credentials beyond a read-only GITHUB_TOKEN; decides from the event and factory.yaml
//             on the default branch whether anything runs (trust gate: owner IDs only).
//   dispatch  environment `globalhost`: kill switch, daily budget, builder slot, the Managed Agents run
//             (GitHub OIDC → Anthropic, ADR-0014), then the publisher with a fresh App token.
// The agent never runs in the job: it runs in the Managed Agents sandbox and returns a bundle.
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gate, parseFactoryYaml, validateFactoryConfig, type FactoryConfig, type GateEvent, type Profile, type Registry } from "@globalhost/core";
import {
  GitHubReader,
  anthropicClient,
  createRepoBundle,
  federationIdsFromEnv,
  githubActionsIdentity,
  resumeRun,
  sdkApi,
  startRun,
  type ManagedAgentsApi,
  type RunRecord,
} from "@globalhost/runner";
import { z } from "zod";
import { ControlPlane, ObjectStore, RUNS_BUCKET, accessSecret, gcloudAccessToken, type AccessToken } from "./gcp.js";
import { CommentSchema, GitHubClient, GitHubError, installationToken, latestMarker, listComments } from "./github.js";
import { githubSnapshot, profileRunSettings } from "./profile-settings.js";
import { LABELS, publish } from "./publish.js";

export interface Env {
  [key: string]: string | undefined;
}

export interface DispatchDeps {
  env: Env;
  registry: Registry;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Full profiles for the parts' profile ids; they supply each run's guidance and network environment. */
  profiles?: readonly Profile[];
  // Test seams.
  api?: ManagedAgentsApi;
  gcpToken?: AccessToken;
  appToken?: (repo: string) => Promise<string>;
  cloneRepo?: typeof createRepoBundle;
}

const need = (env: Env, name: string): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const RepoSlug = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);

/** factory.yaml from the default branch only: a PR branch can't change who the owners are. */
export async function loadConfig(gh: GitHubClient, repo: string, registry: Registry): Promise<FactoryConfig> {
  const meta = await gh.request("GET", `/repos/${repo}`, undefined, z.object({ default_branch: z.string() }));
  const file = await gh.request(
    "GET",
    `/repos/${repo}/contents/factory.yaml?ref=${encodeURIComponent(meta.default_branch)}`,
    undefined,
    z.object({ content: z.string(), encoding: z.literal("base64") }),
  );
  const parsed = parseFactoryYaml(Buffer.from(file.content, "base64"));
  if (!parsed.ok) throw new Error(`factory.yaml: ${parsed.errors.map((e) => `${e.path} ${e.code}`).join("; ")}`);
  const result = validateFactoryConfig(parsed.value, registry);
  if (!result.ok) throw new Error(`factory.yaml: ${result.errors.map((e) => `${e.path || "(root)"} ${e.code}`).join("; ")}`);
  if (result.config.git.defaultBranch !== meta.default_branch) {
    throw new Error(`factory.yaml git.defaultBranch is ${result.config.git.defaultBranch}, but the repo's is ${meta.default_branch}`);
  }
  return result.config;
}

const EventSchema = z.object({
  sender: z.object({ id: z.number().int(), type: z.string() }),
  issue: z.object({ number: z.number().int(), pull_request: z.unknown().optional() }),
  label: z.object({ name: z.string() }).optional(),
  comment: z.object({ id: z.number().int(), body: z.string().nullable() }).optional(),
});

export interface GateOutputs {
  action: "ignore" | "start" | "resume";
  role?: "planner" | "builder";
  issue?: number;
  pr?: number;
  comment?: number;
  reason?: string;
}

export async function gateStep(deps: DispatchDeps): Promise<GateOutputs> {
  const { env } = deps;
  const repo = RepoSlug.parse(need(env, "GITHUB_REPOSITORY"));
  const eventName = need(env, "GITHUB_EVENT_NAME");
  const event = EventSchema.parse(JSON.parse(await readFile(need(env, "GITHUB_EVENT_PATH"), "utf8")));
  const gh = new GitHubClient(need(env, "GITHUB_TOKEN"), deps.fetchImpl);

  let gateEvent: GateEvent;
  if (eventName === "issues" && event.label) {
    gateEvent = { kind: "label", label: event.label.name, senderId: event.sender.id, issue: event.issue.number, isPullRequest: event.issue.pull_request !== undefined };
  } else if (eventName === "issue_comment" && event.comment) {
    let pullRequest: Extract<GateEvent, { kind: "comment" }>["pullRequest"];
    if (event.issue.pull_request !== undefined) {
      const pr = await gh.request("GET", `/repos/${repo}/pulls/${event.issue.number}`, undefined, z.object({
        number: z.number().int(),
        head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
      }));
      pullRequest = { number: pr.number, headRef: pr.head.ref, headRepoIsBase: pr.head.repo?.full_name === repo };
    }
    gateEvent = { kind: "comment", senderId: event.sender.id, senderType: event.sender.type, pullRequest, body: event.comment.body ?? "" };
  } else {
    return { action: "ignore", reason: `unsupported event ${eventName}` };
  }

  let config: FactoryConfig;
  try {
    config = await loadConfig(gh, repo, deps.registry);
  } catch (err) {
    // No comment: the sender may not be an owner, and we can't tell without a valid config.
    return { action: "ignore", reason: (err as Error).message };
  }
  const decision = gate(gateEvent, config.owners.map((o) => o.id));
  if (decision.action === "ignore") return { action: "ignore", reason: decision.reason };
  if (decision.action === "start") return { action: "start", role: decision.role, issue: decision.issue };
  return { action: "resume", role: "builder", issue: decision.issue, pr: decision.pullRequest, comment: event.comment!.id };
}

/** Writes gate outputs for the next job. Every value is a fixed word or an integer. */
export async function writeOutputs(path: string, out: GateOutputs): Promise<void> {
  const lines = [`action=${out.action}`];
  if (out.role) lines.push(`role=${out.role}`);
  for (const k of ["issue", "pr", "comment"] as const) if (out[k] !== undefined) lines.push(`${k}=${out[k]}`);
  await appendFile(path, `${lines.join("\n")}\n`);
}

const intEnv = (env: Env, name: string): number | undefined => {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new Error(`${name} is not a positive integer`);
  return Number(raw);
};

export async function dispatchStep(deps: DispatchDeps): Promise<RunRecord | undefined> {
  const { env, log } = deps;
  const repo = RepoSlug.parse(need(env, "GITHUB_REPOSITORY"));
  const action = need(env, "GLOBALHOST_ACTION");
  const role = need(env, "GLOBALHOST_ROLE");
  const issue = intEnv(env, "GLOBALHOST_ISSUE");
  if ((action !== "start" && action !== "resume") || (role !== "planner" && role !== "builder") || !issue) {
    throw new Error("bad gate outputs");
  }
  const reader = new GitHubClient(need(env, "GITHUB_TOKEN"), deps.fetchImpl);
  const config = await loadConfig(reader, repo, deps.registry);
  const ownerIds = config.owners.map((o) => o.id);
  const botLogin = `${need(env, "GLOBALHOST_APP_SLUG")}[bot]`;

  const gcpToken = deps.gcpToken ?? gcloudAccessToken;
  const control = new ControlPlane(new ObjectStore(gcpToken, deps.fetchImpl));
  // Installation tokens last an hour and runs can take longer, so mint one whenever we write.
  const writer = async () => {
    const token = deps.appToken
      ? await deps.appToken(repo)
      : await installationToken(need(env, "GLOBALHOST_APP_ID"), await accessSecret(gcpToken, "github-app-key", deps.fetchImpl), repo, deps.fetchImpl);
    return { gh: new GitHubClient(token, deps.fetchImpl), token };
  };
  const refuse = async (target: number, text: string) => {
    log(`refused: ${text}`);
    const { gh } = await writer();
    await gh.request("POST", `/repos/${repo}/issues/${target}/comments`, { body: `**globalhost:** ${text}` });
    return undefined;
  };

  const pr = action === "resume" ? intEnv(env, "GLOBALHOST_PR") : undefined;
  const target = pr ?? issue;
  if (await control.paused()) return refuse(target, "the factory is paused (`globalhost resume` to continue). Nothing ran.");
  const spent = await control.spentTodayUsd(repo);
  if (spent + config.limits.perRunUsd > config.limits.dailyUsd) {
    return refuse(target, `today's budget for this repo is used up ($${spent.toFixed(2)} of $${config.limits.dailyUsd}). Nothing ran; try again tomorrow or raise \`limits.dailyUsd\`.`);
  }

  // Branch claim (PLAN P1-07): one builder per issue. An existing branch is steered through its PR.
  const branch = `factory/issue-${issue}`;
  let resumeFrom: { session: string; costUsd: number } | undefined;
  let feedback: string | undefined;
  let approvedPlan: string | undefined;
  if (action === "start" && role === "builder") {
    try {
      await reader.request("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
      return refuse(issue, `\`${branch}\` already exists. Comment on its PR to steer the builder, or delete the branch to start over.`);
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) throw err;
    }
    const plan = latestMarker(await listComments(reader, repo, issue), botLogin, "planner");
    approvedPlan = plan?.comment.body?.replace(/<!-- globalhost:run [^\n]* -->/g, "").trim();
  }
  if (action === "resume") {
    if (!pr) throw new Error("resume without a PR");
    const commentId = intEnv(env, "GLOBALHOST_COMMENT");
    const c = await reader.request("GET", `/repos/${repo}/issues/comments/${commentId}`, undefined, CommentSchema);
    // Re-check the author here: this job doesn't trust anything but its own reads.
    if (!ownerIds.includes(c.user.id) || c.user.type !== "User") throw new Error("steering comment is not by an owner");
    feedback = c.body ?? "";
    const prev = latestMarker(await listComments(reader, repo, pr), botLogin, "builder");
    if (!prev) return refuse(pr, "no earlier builder session found on this PR, so there's nothing to steer. Re-apply `factory:build` on the issue to start fresh.");
    resumeFrom = { session: prev.marker.session, costUsd: prev.marker.costUsd };
  }

  const holder = `${issue}-${need(env, "GITHUB_RUN_ID")}`;
  const slot = role === "builder" ? await control.acquireSlot(repo, holder, config.limits.maxConcurrentBuilders, config.limits.perRunMinutes + 30) : null;
  if (role === "builder" && !slot) {
    return refuse(target, `all ${config.limits.maxConcurrentBuilders} builder slot(s) for this repo are busy. Re-apply the label (or comment again) when the current run finishes.`);
  }
  try {
    const api = deps.api ?? sdkApi(anthropicClient(federationIdsFromEnv(env as NodeJS.ProcessEnv), githubActionsIdentity(env as NodeJS.ProcessEnv, deps.fetchImpl)));
    const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${role}-${issue}-${need(env, "GITHUB_RUN_ID")}`;
    const outDir = join(need(env, "RUNNER_TEMP"), "globalhost", runId);
    const settings = deps.profiles ? await profileRunSettings(deps.profiles, config, await githubSnapshot(reader, repo, config.git.defaultBranch)) : {};
    const runDeps = {
      api,
      github: new GitHubReader(env.GITHUB_TOKEN, deps.fetchImpl),
      githubToken: env.GITHUB_TOKEN,
      log,
      onEvent: (e: { type: string; toolName?: string }) => {
        // Tool names only: agent text can echo untrusted input and stays out of the Actions log.
        if (e.type === "agent.tool_use") log(`  · ${e.toolName ?? "tool"}`);
      },
      cloneRepo: deps.cloneRepo,
    };
    const record = resumeFrom
      ? await resumeRun({ sessionId: resumeFrom.session, feedback: feedback!, addBudgetUsd: config.limits.perRunUsd, timeoutMinutes: config.limits.perRunMinutes, outDir }, runDeps)
      : await startRun(
          {
            runId,
            role,
            repo,
            issue,
            budgetUsd: config.limits.perRunUsd,
            timeoutMinutes: config.limits.perRunMinutes,
            outDir,
            ownerIds,
            approvedPlan,
            guidance: settings.guidance,
            environment: settings.environment,
          },
          runDeps,
        );

    await control.recordSpend(repo, record.runId, Math.max(0, record.costUsd - (resumeFrom?.costUsd ?? 0)));
    await archive(new ObjectStore(gcpToken, deps.fetchImpl), repo, record, outDir);

    const issueInfo = await reader.request("GET", `/repos/${repo}/issues/${issue}`, undefined, z.object({ title: z.string() }));
    const base = await (deps.cloneRepo ?? createRepoBundle)(`https://github.com/${repo}.git`, config.git.defaultBranch, env.GITHUB_TOKEN);
    const { gh, token } = await writer();
    const result = await publish({ gh, pushToken: token, repo, issue, issueTitle: issueInfo.title, config, record, outDir, base, pullRequest: pr, log });
    log(`published: ${result.outcome}${result.pullRequest ? ` (#${result.pullRequest})` : ""}`);
    return record;
  } finally {
    if (slot) await control.releaseSlot(slot, holder).catch(() => undefined);
  }
}

const ARCHIVED = ["run.json", "report.json", "plan.md", "result.bundle"];

async function archive(store: ObjectStore, repo: string, record: RunRecord, outDir: string): Promise<void> {
  for (const name of ARCHIVED) {
    let data: Buffer;
    try {
      data = await readFile(join(outDir, name));
    } catch {
      continue;
    }
    await store.write(RUNS_BUCKET, `${repo}/${record.runId}/turn-${record.turn}/${name}`, data, undefined, "application/octet-stream");
  }
}

export { LABELS };
