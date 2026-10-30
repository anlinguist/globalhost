// Task-message assembly with trust tagging (ARCHITECTURE §4). Owner-authored text is direction;
// everything else is sanitized and fenced as data. The role's standing instructions are in the agent's
// system prompt (packages/roles); this message carries only the run's specifics.
import { UNTRUSTED_PREAMBLE, fenceUntrusted, sanitizeUntrusted } from "@globalhost/sanitize";
import type { RoleId } from "@globalhost/roles";
import type { Author, IssueInput } from "./github.js";

export const REPO_BUNDLE_MOUNT = "/repo.bundle";
const REPO_BUNDLE_PATH = `/mnt/session/uploads${REPO_BUNDLE_MOUNT}`;
const OUTPUTS = "/mnt/session/outputs";

export const COMMIT_IDENTITY = { name: "globalhost-ai", email: "globalhost-ai@users.noreply.github.com" };

export interface TaskContext {
  role: RoleId;
  repo: string;
  defaultBranch: string;
  baseSha: string;
  issue: IssueInput;
  ownerIds: ReadonlySet<number>;
  /** Builder only: the branch to commit on. */
  branch?: string;
  /** Builder only: the plan the owner approved, if any. Agent-written, so it's fenced. */
  approvedPlan?: string;
  /** Profile guidance for this repo's part (from the profile's skill), owner-trusted factory text. */
  guidance?: string;
}

const isOwner = (ctx: TaskContext, a: Author) => ctx.ownerIds.has(a.id);

function authored(ctx: TaskContext, source: string, author: Author, text: string): string {
  if (isOwner(ctx, author)) return sanitizeUntrusted(text);
  return fenceUntrusted({ source, author: author.login, text });
}

export function buildTaskMessage(ctx: TaskContext): string {
  const { issue } = ctx;
  const out: string[] = [];
  out.push(`# Task: ${ctx.role} for ${ctx.repo}, issue #${issue.number}`, "", UNTRUSTED_PREAMBLE, "");

  out.push(
    "## Repository",
    "",
    `- Clone it with \`git clone ${REPO_BUNDLE_PATH} /workspace/repo\` and work in /workspace/repo.`,
    `- The default branch is \`${ctx.defaultBranch}\`; the base commit is \`${ctx.baseSha}\`.`,
  );
  if (ctx.role === "builder") {
    if (!ctx.branch) throw new Error("builder task needs a branch");
    out.push(
      `- Create branch \`${ctx.branch}\` from the base commit and commit only there.`,
      `- Commit identity: \`git config user.name "${COMMIT_IDENTITY.name}"\` and \`git config user.email "${COMMIT_IDENTITY.email}"\`.`,
    );
  }
  out.push("");

  if (ctx.guidance) out.push("## Guidance for this kind of project", "", ctx.guidance.trim(), "");

  const owner = isOwner(ctx, issue.author);
  out.push(`## Issue #${issue.number} (opened by @${issue.author.login}${owner ? ", the owner" : ", not the owner"})`, "");
  if (owner) {
    out.push(`**${sanitizeUntrusted(issue.title)}**`, "", sanitizeUntrusted(issue.body) || "(no description)");
  } else {
    out.push(fenceUntrusted({ source: "issue", author: issue.author.login, text: `${issue.title}\n\n${issue.body}` }));
  }
  out.push("");

  if (issue.comments.length > 0) {
    out.push("## Comments, oldest first", "");
    for (const c of issue.comments) {
      const who = isOwner(ctx, c.author) ? `@${c.author.login} (owner)` : `@${c.author.login} (not the owner)`;
      out.push(`### ${who}, ${c.createdAt}`, "", authored(ctx, "issue-comment", c.author, c.body), "");
    }
  }

  if (ctx.approvedPlan) {
    out.push(
      "## Approved plan",
      "",
      "The planner wrote this plan and the owner approved the build after reading it. Use it as your starting point; where it conflicts with the owner's own words above, the owner wins.",
      "",
      fenceUntrusted({ source: "approved-plan", author: "globalhost-planner", text: ctx.approvedPlan }),
      "",
    );
  }

  out.push("## Outputs", "");
  if (ctx.role === "builder") {
    out.push(
      `1. \`git -C /workspace/repo bundle create ${OUTPUTS}/result.bundle ${ctx.branch} ^${ctx.baseSha}\``,
      `2. \`${OUTPUTS}/report.json\` as described in your instructions.`,
    );
  } else {
    out.push(`1. \`${OUTPUTS}/plan.md\``, `2. \`${OUTPUTS}/report.json\` as described in your instructions.`);
  }
  return out.join("\n");
}

/** A follow-up turn on the same session: owner feedback from a PR or issue comment. */
export function buildFeedbackMessage(ctx: Pick<TaskContext, "role" | "branch" | "baseSha">, feedback: string): string {
  const lines = [
    "## Owner feedback on your previous attempt",
    "",
    sanitizeUntrusted(feedback),
    "",
    "Address it, then write fresh outputs (overwrite the previous files):",
  ];
  if (ctx.role === "builder") {
    lines.push(
      `1. Add commits on \`${ctx.branch}\`; keep earlier commits unless the feedback says to redo them.`,
      `2. \`git -C /workspace/repo bundle create ${OUTPUTS}/result.bundle ${ctx.branch} ^${ctx.baseSha}\``,
      `3. \`${OUTPUTS}/report.json\``,
    );
  } else {
    lines.push(`1. \`${OUTPUTS}/plan.md\``, `2. \`${OUTPUTS}/report.json\``);
  }
  return lines.join("\n");
}
