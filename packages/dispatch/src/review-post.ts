// Posting a review in shadow mode (P2-01): one GitHub review per head SHA, event COMMENT only (never APPROVE
// or REQUEST_CHANGES, never a merge), found again by its marker and updated in place rather than duplicated.
// Everything the reviewer wrote (summary, titles, details) is untrusted: it goes into code spans and fenced
// blocks sized so it can't close them, after control characters are stripped and HTML comment delimiters are
// broken. So it can't mention anyone, link or close an issue, inject HTML, or forge a marker. Verdicts,
// categories and escalation reasons are closed sets and render as fixed text.
import { ESCALATION_REASONS, type EscalationReason, type ReviewRecord, type Verdict } from "@globalhost/core";
import { stripControlChars } from "@globalhost/sanitize";
import { z } from "zod";
import type { GitHubClient } from "./github.js";
import { LABELS } from "./publish.js";

const MARKER_PREFIX = "<!-- globalhost:review ";
const MARKER = /^<!-- globalhost:review (\{"sha":"[0-9a-f]{40}","run":"[A-Za-z0-9_.-]{1,100}"\}) -->(?:\n|$)/;
const ReviewMarkerSchema = z.strictObject({ sha: z.string().regex(/^[0-9a-f]{40}$/), run: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/) });
export type ReviewMarker = z.infer<typeof ReviewMarkerSchema>;

/** The hidden first line of every posted review. */
export function reviewMarker(m: ReviewMarker): string {
  const v = ReviewMarkerSchema.parse(m);
  return `${MARKER_PREFIX}${JSON.stringify({ sha: v.sha, run: v.run })} -->`;
}

/** The marker of a review body, read only from its first line; anything else (or a malformed one) is null. */
export function parseReviewMarker(body: string | null): ReviewMarker | null {
  if (!body) return null;
  const m = MARKER.exec(body);
  if (!m) return null;
  try {
    const parsed = ReviewMarkerSchema.safeParse(JSON.parse(m[1]!));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Fixed text for each escalation reason. Never built from reviewer output. */
export const ESCALATION_TEXT: Record<EscalationReason, string> = {
  "invalid-output": "the reviewer's output didn't match the review schema",
  "missing-output": "the reviewer returned no output",
  timeout: "the review timed out",
  "run-failed": "the review run failed",
  "budget-exhausted": "the PR's review budget (or today's budget) is used up",
  "scan-hit": "the diff, commit messages or CI output contain text aimed at the reviewer",
  "reviewer-escalated": "the reviewer escalated an area",
  "security-category": "a security finding in auth, IAM, secrets or supply chain",
  "reviewer-manipulation": "the reviewer reported an attempt to manipulate it",
  unreviewable: "the reviewer reported the change as unreviewable",
  "verifier-rejected-security": "the verifier rejected a security finding",
};

/** Untrusted text with control and bidi characters gone and anything that could open or close an HTML comment broken. */
function neutral(text: string): string {
  return stripControlChars(text, "NFC")
    .replace(/<!/g, "<\u200b!")
    .replace(/--(?=>)/g, "-\u200b-")
    .replace(/--!>/g, "-\u200b-!>");
}

const longestRun = (text: string, ch: string): number => {
  let best = 0;
  let cur = 0;
  for (const c of text) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
};

/** One line of untrusted text as an inline code span that nothing inside can close. */
export function codeSpan(text: string, max = 300): string {
  let t = neutral(text).replace(/[\n\r\t\v\f\u0085\u2028\u2029]+/g, " ").trim();
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  if (t === "") return "*(empty)*";
  const fence = "`".repeat(longestRun(t, "`") + 1);
  return `${fence} ${t} ${fence}`;
}

/** Untrusted text as a fenced block that nothing inside can close (the fence is longer than any backtick run). */
export function codeBlock(text: string, max = 2000): string {
  let t = neutral(text).replace(/\r\n?/g, "\n").trimEnd();
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  if (t === "") return "*(empty)*";
  const fence = "`".repeat(Math.max(3, longestRun(t, "`") + 1));
  return `${fence}text\n${t}\n${fence}`;
}

const VERDICT_WORD: Record<Verdict, string> = { pass: "pass", changes: "changes", escalate: "escalate" };

/** GitHub allows 65 536 characters in a review body; stay well under. */
export const MAX_REVIEW_BODY = 60_000;
const MAX_DETAIL_SHOWN = 1500;

export interface RenderContext {
  record: ReviewRecord;
  summary: string | null;
  /** Indexes into record.findings whose file the reviewer named outside the diff (the harness cleared it). */
  outsideDiff: ReadonlySet<number>;
  runUrl?: string;
}

/** The review body: marker, fixed-text verdicts and reasons, then reviewer text fenced. */
export function renderReviewBody({ record, summary, outsideDiff, runUrl }: RenderContext): string {
  const parts: string[] = [];
  parts.push(reviewMarker({ sha: record.sha, run: record.runId }));
  parts.push(`**globalhost review (shadow)** of \`${record.sha.slice(0, 12)}\`: **${VERDICT_WORD[record.overall]}**`);
  parts.push("Shadow mode: this review is recorded for calibration. It doesn't approve, block or merge anything.");
  parts.push(
    [
      "| Area | Verdict |",
      "|---|---|",
      `| function | ${VERDICT_WORD[record.verdicts.function]} |`,
      `| security | ${VERDICT_WORD[record.verdicts.security]} |`,
      `| performance | ${VERDICT_WORD[record.verdicts.performance]} |`,
    ].join("\n"),
  );
  if (record.escalations.length > 0) {
    const reasons = ESCALATION_REASONS.filter((r) => record.escalations.includes(r));
    parts.push(`**Needs the owner:**\n${reasons.map((r) => `- ${ESCALATION_TEXT[r]}`).join("\n")}`);
  }
  if (record.status !== "completed") parts.push(`Review status: \`${record.status}\`.`);
  if (summary !== null) parts.push(`**Reviewer summary** (reviewer-written, shown as text):\n\n${codeBlock(summary)}`);

  const footer = [
    `<sub>run \`${record.runId}\` · $${record.costUsd.toFixed(2)} (PR total $${record.prSpendUsd.toFixed(2)})`,
    record.ciRunId ? ` · CI run ${record.ciRunId}` : "",
    record.scanHits.length ? ` · scan: ${[...new Set(record.scanHits.map((h) => h.code))].join(", ")}` : "",
    runUrl ? ` · [Actions run](${runUrl})` : "",
    "</sub>",
  ].join("");

  let body = parts.join("\n\n");
  if (record.findings.length > 0) body += `\n\n**Findings (${record.findings.length})**`;
  let shown = 0;
  for (const [i, f] of record.findings.entries()) {
    const where =
      f.file !== null ? ` · ${codeSpan(f.line !== null ? `${f.file}:${f.line}` : f.file)}` : outsideDiff.has(i) ? " · *(a file outside this diff)*" : "";
    const block = [
      `#### ${i + 1}. ${f.severity} · ${f.area} / ${f.category} · \`${f.code}\`${where}`,
      codeSpan(f.title, 200),
      f.detail.trim() ? codeBlock(f.detail, MAX_DETAIL_SHOWN) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (body.length + block.length + footer.length + 200 > MAX_REVIEW_BODY) break;
    body += `\n\n${block}`;
    shown++;
  }
  if (shown < record.findings.length) body += `\n\n*${record.findings.length - shown} more finding(s) are in the archived record.*`;
  return `${body}\n\n${footer}\n`;
}

const ReviewListSchema = z.array(
  z.object({ id: z.number().int().positive(), body: z.string().nullable(), user: z.object({ login: z.string(), type: z.string() }).nullable() }),
);

/** The bot's existing review for `sha` on the PR, by marker. Only reviews by the bot user count. */
export async function findPostedReview(gh: GitHubClient, repo: string, pr: number, sha: string, botLogin: string): Promise<number | null> {
  for (let page = 1; page <= 5; page++) {
    const batch = await gh.request("GET", `/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`, undefined, ReviewListSchema);
    for (const r of batch) {
      if (r.user?.type !== "Bot" || r.user.login !== botLogin) continue;
      if (parseReviewMarker(r.body)?.sha === sha) return r.id;
    }
    if (batch.length < 100) break;
  }
  return null;
}

export interface PostReviewInput {
  gh: GitHubClient;
  repo: string;
  pr: number;
  record: ReviewRecord;
  body: string;
  botLogin: string;
}

/**
 * Posts (or updates) the review for record.sha as a COMMENT on that commit, and on escalation adds
 * needs:owner-approval. Returns the review ID.
 */
export async function postReview({ gh, repo, pr, record, body, botLogin }: PostReviewInput): Promise<number> {
  const existing = await findPostedReview(gh, repo, pr, record.sha, botLogin);
  const Posted = z.object({ id: z.number().int().positive() });
  const id = existing
    ? (await gh.request("PUT", `/repos/${repo}/pulls/${pr}/reviews/${existing}`, { body }, Posted)).id
    : (await gh.request("POST", `/repos/${repo}/pulls/${pr}/reviews`, { commit_id: record.sha, event: "COMMENT", body }, Posted)).id;
  if (record.overall === "escalate") {
    await gh.request("POST", `/repos/${repo}/issues/${pr}/labels`, { labels: [LABELS.needsApproval] });
  }
  return id;
}
