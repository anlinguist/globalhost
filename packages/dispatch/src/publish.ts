// The publisher (ARCHITECTURE §2.3 step 5): trusted code that turns a run's outputs into GitHub
// operations. It re-verifies the bundle, applies the path policy, pushes only factory/issue-<n>
// (never forced), opens a draft PR, and reports. Everything the agent wrote is shown as data.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { evaluatePathPolicy, pathPolicyAllows, type FactoryConfig } from "@globalhost/core";
import { inspectResultBundle, type RepoBundle, type RunRecord } from "@globalhost/runner";
import { z } from "zod";
import { GitHubClient, GitHubError, PullSchema, marker, type Pull } from "./github.js";

const exec = promisify(execFile);

export const LABELS = {
  plan: "factory:plan",
  planned: "factory:planned",
  build: "factory:build",
  inReview: "factory:in-review",
  blocked: "factory:blocked",
  failed: "factory:failed",
  needsApproval: "needs:owner-approval",
} as const;

const MAX_COMMENT = 60_000;

/** Agent-written text, made safe to post as the bot: no pings, no hidden markers, bounded. */
export function asPostable(text: string, max = MAX_COMMENT): string {
  let out = text
    .replace(/<!--/g, "&lt;!--")
    // A zero-width joiner after @ stops GitHub from notifying (or team-pinging) anyone.
    .replace(/@(?=[A-Za-z0-9-])/g, "@‍");
  if (out.length > max) out = `${out.slice(0, max)}\n\n…(truncated)`;
  return out;
}

const STATUS_LINE: Record<RunRecord["status"], string> = {
  succeeded: "✅ succeeded",
  blocked: "❓ blocked: the agent needs an answer",
  failed: "❌ failed",
  cap_exceeded: "💸 stopped at its budget cap",
  timeout: "⏱️ timed out",
};

export function runReport(record: RunRecord, extra: string[] = []): string {
  // Assessments are posted by `globalhost assess` as an onboarding issue, never through the dispatcher.
  if (record.role === "assessor") throw new Error("the dispatcher doesn't publish assessments");
  const lines = [
    `**globalhost ${record.role}** ${STATUS_LINE[record.status]}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Cost | $${record.costUsd.toFixed(2)} of $${record.budgetUsd.toFixed(2)} (session total) |`,
    `| Time | ${Math.round(record.wallSeconds / 60)} min |`,
    `| Turn | ${record.turn} |`,
    `| Base | \`${record.baseSha.slice(0, 12)}\` |`,
  ];
  if (record.outputs.bundle) {
    const b = record.outputs.bundle;
    lines.push(`| Commits | ${b.commits}, ${b.filesChanged.length} file(s) changed |`);
  }
  const r = record.report;
  if (r) {
    lines.push("", "**Summary (agent-written)**", "", asPostable(r.summary, 4000));
    if (r.acceptanceTests.length > 0) {
      lines.push("", "**Acceptance tests**", "");
      for (const t of r.acceptanceTests) {
        const fails = t.failsOnBase === undefined ? "" : t.failsOnBase ? ", fails on base" : ", **passes on base**";
        lines.push(`- ${asPostable(t.name, 300)} (${t.status}${fails})`);
      }
    }
    if (r.checks.length > 0) {
      lines.push("", "**Checks**", "");
      for (const c of r.checks) lines.push(`- ${c.passed ? "✅" : "❌"} ${asPostable(c.name, 100)}: \`${asPostable(c.command, 300).replace(/`/g, "'")}\``);
    }
    if (r.questions.length > 0) {
      lines.push("", "**Questions for the owner**", "");
      for (const q of r.questions) lines.push(`- ${asPostable(q, 1000)}`);
    }
    if (r.notes) lines.push("", "**Notes (agent-written)**", "", asPostable(r.notes, 4000));
  }
  if (record.problems.length > 0) {
    lines.push("", "**Harness problems**", "");
    for (const p of record.problems) lines.push(`- ${asPostable(p, 500)}`);
  }
  lines.push(...extra);
  lines.push(
    "",
    `<sub>Steer the builder by commenting on its PR. Start a comment with \`>\` or include \`[no-factory]\` to leave it alone. Session \`${record.sessionId}\`.</sub>`,
    marker({ role: record.role, session: record.sessionId, run: record.runId, costUsd: record.costUsd }),
  );
  return lines.join("\n");
}

export interface PublishContext {
  gh: GitHubClient;
  /** The same installation token, for git push over HTTPS (never in argv). */
  pushToken: string;
  repo: string;
  issue: number;
  issueTitle: string;
  config: FactoryConfig;
  record: RunRecord;
  outDir: string;
  /** A bare clone at the base, for re-verifying the bundle and pushing from. */
  base: RepoBundle;
  /** Set when steering an existing PR. */
  pullRequest?: number;
  log: (line: string) => void;
  /** Test seam: where to push (default https://github.com/<repo>.git). */
  remoteUrl?: string;
}

export interface PublishResult {
  outcome: "planned" | "pr" | "blocked" | "failed" | "rejected";
  pullRequest?: number;
}

async function addLabels(gh: GitHubClient, repo: string, issue: number, labels: string[]) {
  if (labels.length > 0) await gh.request("POST", `/repos/${repo}/issues/${issue}/labels`, { labels });
}

async function removeLabel(gh: GitHubClient, repo: string, issue: number, label: string) {
  try {
    await gh.request("DELETE", `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err;
  }
}

async function comment(gh: GitHubClient, repo: string, issue: number, body: string) {
  await gh.request("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
}

export async function publish(ctx: PublishContext): Promise<PublishResult> {
  const { gh, repo, issue, record } = ctx;
  const startLabel = record.role === "planner" ? LABELS.plan : LABELS.build;
  const target = ctx.pullRequest ?? issue;

  if (record.status === "succeeded" || (record.status === "blocked" && record.role === "planner" && record.outputs.planBytes)) {
    if (record.role === "planner") {
      const plan = (await readFile(join(ctx.outDir, "plan.md"), "utf8")).trim();
      const body = [
        // The planner usually titles its own plan; add one only when it didn't.
        ...(/^#{1,3} /.test(plan) ? [] : [`## Plan for #${issue}`, ""]),
        asPostable(plan, 50_000),
        "",
        "---",
        "",
        runReport(record, [
          "",
          `Apply \`${LABELS.build}\` to build this plan, or reply here to revise it (the planner picks up where it left off; start a reply with \`>\` or add \`[no-factory]\` to just comment).`,
        ]),
      ].join("\n");
      await comment(gh, repo, issue, body);
      await removeLabel(gh, repo, issue, startLabel);
      // A revised plan replaces whichever state the last one left.
      await removeLabel(gh, repo, issue, record.status === "blocked" ? LABELS.planned : LABELS.blocked);
      await addLabels(gh, repo, issue, [record.status === "blocked" ? LABELS.blocked : LABELS.planned]);
      return { outcome: record.status === "blocked" ? "blocked" : "planned" };
    }
    return publishBuild(ctx);
  }

  const reason =
    record.status === "blocked"
      ? "The agent stopped to ask questions. Answer them in a comment, then re-apply the label (or, on a PR, just reply)."
      : "Nothing was pushed.";
  await comment(gh, repo, target, runReport(record, ["", reason]));
  if (!ctx.pullRequest) await removeLabel(gh, repo, issue, startLabel);
  await addLabels(gh, repo, issue, [record.status === "blocked" ? LABELS.blocked : LABELS.failed]);
  return { outcome: record.status === "blocked" ? "blocked" : "failed" };
}

async function publishBuild(ctx: PublishContext): Promise<PublishResult> {
  const { gh, repo, issue, record } = ctx;
  const branch = `factory/issue-${issue}`;

  // Re-verify in this process: the bundle on disk is what gets pushed, whatever run.json says.
  const bundle = await inspectResultBundle(ctx.base.bareDir, join(ctx.outDir, "result.bundle"), record.baseSha, branch);
  const policy = evaluatePathPolicy(bundle.filesChanged, ctx.config.guardrails);
  if (!pathPolicyAllows(policy)) {
    const bad = [...policy.rejected.map((r) => `\`${asPostable(r.path, 200)}\` (protected by \`${r.pattern}\`)`), ...policy.malformed.map((p) => `\`${asPostable(p, 200)}\` (not a plain repo path)`)];
    await comment(
      gh,
      repo,
      ctx.pullRequest ?? issue,
      runReport(record, [
        "",
        "**Rejected by the path policy; nothing was pushed.** Agents may not change these files (FACTORY-YAML §3.8):",
        "",
        ...bad.map((b) => `- ${b}`),
        "",
        "If the change is needed, make it yourself.",
      ]),
    );
    if (!ctx.pullRequest) await removeLabel(gh, repo, issue, LABELS.build);
    await addLabels(gh, repo, issue, [LABELS.failed]);
    return { outcome: "rejected" };
  }

  try {
    await pushBranch(ctx.base.bareDir, ctx.remoteUrl ?? `https://github.com/${repo}.git`, branch, ctx.pushToken);
  } catch (err) {
    await comment(gh, repo, ctx.pullRequest ?? issue, runReport(record, ["", `**Push to \`${branch}\` failed:** ${asPostable((err as Error).message, 500)}`]));
    await addLabels(gh, repo, issue, [LABELS.failed]);
    return { outcome: "failed" };
  }
  ctx.log(`pushed ${branch} @ ${bundle.headSha.slice(0, 12)}`);

  const pr = ctx.pullRequest ? await getPull(gh, repo, ctx.pullRequest) : await findOrCreatePull(ctx, branch);
  const approval = policy.needsApproval.length > 0
    ? ["", `**Needs owner approval** (load-bearing paths): ${policy.needsApproval.map((n) => `\`${asPostable(n.path, 200)}\``).join(", ")}`]
    : [];
  await comment(gh, repo, pr.number, runReport(record, approval));
  if (policy.needsApproval.length > 0) await addLabels(gh, repo, pr.number, [LABELS.needsApproval]);
  if (!ctx.pullRequest) await removeLabel(gh, repo, issue, LABELS.build);
  await removeLabel(gh, repo, issue, LABELS.failed);
  await removeLabel(gh, repo, issue, LABELS.blocked);
  await addLabels(gh, repo, issue, [LABELS.inReview]);
  return { outcome: "pr", pullRequest: pr.number };
}

async function getPull(gh: GitHubClient, repo: string, n: number): Promise<Pull> {
  return gh.request("GET", `/repos/${repo}/pulls/${n}`, undefined, PullSchema);
}

async function findOrCreatePull(ctx: PublishContext, branch: string): Promise<Pull> {
  const owner = ctx.repo.split("/")[0]!;
  const open = await ctx.gh.request(
    "GET",
    `/repos/${ctx.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    undefined,
    z.array(PullSchema),
  );
  if (open[0]) return open[0];
  const body = [
    `Closes #${ctx.issue}`,
    "",
    "Built by the globalhost builder; the run report is in the first comment. CI and the preview run on this PR. The owner merges.",
  ].join("\n");
  return ctx.gh.request(
    "POST",
    `/repos/${ctx.repo}/pulls`,
    { title: `factory: ${asPostable(ctx.issueTitle, 200)}`, head: branch, base: ctx.config.git.baseBranch, body, draft: true },
    PullSchema,
  );
}

/** Non-forced push of the verified result to factory/issue-<n>. The token travels in the environment. */
export async function pushBranch(bareDir: string, remoteUrl: string, branch: string, token: string): Promise<void> {
  if (!/^factory\/issue-[1-9][0-9]{0,9}$/.test(branch)) throw new Error(`refusing to push ${branch}`);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  await exec(
    "git",
    ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", "--porcelain", remoteUrl, `refs/globalhost/result:refs/heads/${branch}`],
    {
      cwd: bareDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
    },
  );
}
