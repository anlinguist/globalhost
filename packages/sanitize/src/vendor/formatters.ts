/**
 * VENDORED from gp-foundry (MIT, Copyright (c) 2026 The General Partnership).
 * Source: https://github.com/thegpvc/gp-foundry/blob/a1dca903c879250d1f598c90d47eebafc1c2e5ee/actions/agent-context/src/formatters.ts
 * Commit: a1dca903c879250d1f598c90d47eebafc1c2e5ee
 * License: see packages/sanitize/NOTICE.
 *
 * Changes from upstream (globalhost, ADR-0001):
 *   - Bodies are framed with our fenceUntrusted() (`<untrusted source author>`)
 *     instead of upstream's backtick fence + banner.
 *   - `trustedAuthors` means the owner (docs/ARCHITECTURE.md section 4): their bodies
 *     are scrubbed (controls, length, secrets) but not fenced, since they are
 *     instructions. Upstream's "reviewer bot" banner is removed.
 *   - Titles are fenced inline instead of scrubbed in place; labels, logins,
 *     paths and other one-line fields are scrubbed to a single line.
 *   - The diff is fenced as untrusted (NFC, 100k chars) instead of left verbatim.
 *   - Removed the `sanitize: false` escape hatch; sanitizing is unconditional.
 */
import { fenceUntrustedReport, neutralizeFenceTags, sanitizeUntrustedReport } from "../untrusted.js";

const DIFF_LIMIT = 100_000;
const TITLE_LIMIT = 300;

/** A GitHub user reference, as returned by the REST API. */
export interface GitHubUser {
  login: string;
}

/** A label attached to an issue. */
export interface IssueLabel {
  name: string;
}

/** An issue as consumed by the formatters. */
export interface IssueData {
  title: string;
  body: string | null;
  user?: GitHubUser | null;
  labels?: Array<IssueLabel | string>;
}

/** A pull request as consumed by the formatters. */
export interface PullRequestData {
  title: string;
  body: string | null;
  user?: GitHubUser | null;
  changed_files: number;
  additions: number;
  deletions: number;
  base?: { ref?: string } | null;
}

/** A timeline / issue comment. */
export interface CommentData {
  user: GitHubUser | null;
  created_at: string;
  body: string | null;
}

/** A pull request review. */
export interface ReviewData {
  user: GitHubUser | null;
  state: string;
  submitted_at?: string;
  body: string | null;
}

/** An inline pull request review comment. */
export interface InlineCommentData {
  user: GitHubUser | null;
  path: string;
  line: number | null;
  body: string | null;
}

/** The union of all shapes {@link formatContext} may receive. */
export interface ContextData {
  issue?: IssueData;
  pr?: PullRequestData;
  comments?: CommentData[];
  reviews?: ReviewData[];
  inlineComments?: InlineCommentData[];
  diff?: string | null;
}

/** Context type discriminator. */
export type ContextType = "issue" | "pr-diff" | "pr-review" | "pr-full";

/** What the sanitizer neutralized while formatting, for the caller to surface. */
export interface SanitizeStats {
  secretHits: number;
  truncated: number;
}

/** Options controlling how a context is formatted. */
export interface FormatOptions {
  type: ContextType;
  number: number;
  triggeringComment?: string;
  /** Login of the triggering comment's author, if known. */
  triggeringAuthor?: string;
  /**
   * Owner logins. Their bodies are instructions (ARCHITECTURE section 4): still
   * scrubbed, but not fenced. Everyone else's text is fenced as untrusted.
   */
  trustedAuthors?: string[];
  /** Optional accumulator; counts are added to it as sections are formatted. */
  stats?: SanitizeStats;
}

/** Indent each line of text by two spaces. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function record(opts: FormatOptions, secretHits: number, truncated: boolean): void {
  if (!opts.stats) return;
  opts.stats.secretHits += secretHits;
  if (truncated) opts.stats.truncated += 1;
}

/** A one-line field (login, label, path, timestamp): scrubbed, single line, short. */
function oneLine(text: string | null | undefined, opts: FormatOptions, max = 200): string {
  const r = sanitizeUntrustedReport(text ?? "", { maxLength: max });
  record(opts, r.secretHits, false);
  return neutralizeFenceTags(r.text.replace(/\s+/g, " ").trim());
}

function fenced(
  source: string,
  author: string | null | undefined,
  text: string | null | undefined,
  opts: FormatOptions,
  extra: { maxLength?: number; normalization?: "NFKC" | "NFC" } = {},
): string {
  const { text: out, report } = fenceUntrustedReport({ source, author, text: text ?? "" }, extra);
  record(opts, report.secretHits, report.truncated);
  return out;
}

/** Is this body the owner's rather than someone else's? */
function isTrustedAuthor(login: string | null | undefined, opts: FormatOptions): boolean {
  if (!login || !opts.trustedAuthors?.length) return false;
  return opts.trustedAuthors.some((a) => a.toLowerCase() === login.toLowerCase());
}

/** An owner-authored body: scrubbed, not fenced. */
function fromOwner(text: string | null | undefined, opts: FormatOptions): string {
  const r = sanitizeUntrustedReport(text ?? "");
  record(opts, r.secretHits, r.truncated);
  return indent(r.text);
}

/** Route a body to the right framing based on who wrote it. */
function bodyOf(
  source: string,
  text: string | null | undefined,
  login: string | null | undefined,
  opts: FormatOptions,
): string {
  return isTrustedAuthor(login, opts) ? fromOwner(text, opts) : indent(fenced(source, login, text, opts));
}

/** A title: fenced on its own so it stays visibly separate from the structure. */
function title(source: string, text: string, login: string | null | undefined, opts: FormatOptions): string {
  if (isTrustedAuthor(login, opts)) return oneLine(text, opts, TITLE_LIMIT);
  return fenced(source, login, text.replace(/\s+/g, " "), opts, { maxLength: TITLE_LIMIT });
}

/** Normalize a label (which may be a string or an object) to its name. */
function labelName(label: IssueLabel | string): string {
  return typeof label === "string" ? label : label.name;
}

/** Format the issue header section. */
function formatIssueHeader(issue: IssueData, number: number, opts: FormatOptions): string {
  const author = issue.user?.login;
  const lines = [`=== ISSUE #${number} ===`, `Title:\n${title("issue-title", issue.title, author, opts)}`];
  if (author) lines.push(`Author: ${oneLine(author, opts)}`);
  if (issue.labels && issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.map((l) => oneLine(labelName(l), opts)).join(", ")}`);
  }
  lines.push("Body:");
  lines.push(bodyOf("issue-body", issue.body, author, opts));
  return lines.join("\n");
}

/** Format the PR header section. */
function formatPRHeader(pr: PullRequestData, number: number, opts: FormatOptions): string {
  const author = pr.user?.login;
  const lines = [
    `=== PR #${number} ===`,
    `Title:\n${title("pr-title", pr.title, author, opts)}`,
    `Files: ${Number(pr.changed_files)} changed, +${Number(pr.additions)} -${Number(pr.deletions)}`,
    "Body:",
    bodyOf("pr-body", pr.body, author, opts),
  ];
  return lines.join("\n");
}

/** Format the comments section. Returns empty string if no comments. */
function formatComments(comments: CommentData[] | undefined, opts: FormatOptions): string {
  if (!comments || comments.length === 0) return "";
  const header = `=== COMMENTS (${comments.length}) ===`;
  const entries = comments.map(
    (c) =>
      `[${oneLine(c.user?.login ?? "unknown", opts)}] ${oneLine(c.created_at, opts)}\n${bodyOf("comment", c.body, c.user?.login, opts)}`,
  );
  return [header, ...entries].join("\n");
}

/** Format the reviews section. Returns empty string if no reviews. */
function formatReviews(reviews: ReviewData[] | undefined, opts: FormatOptions): string {
  if (!reviews || reviews.length === 0) return "";
  const header = `=== REVIEWS (${reviews.length}) ===`;
  const entries = reviews.map((r) => {
    const bodyText = r.body ? bodyOf("review", r.body, r.user?.login, opts) : "  (no body)";
    return `[${oneLine(r.user?.login ?? "unknown", opts)}] ${oneLine(r.state, opts)} ${oneLine(r.submitted_at, opts)}\n${bodyText}`;
  });
  return [header, ...entries].join("\n");
}

/** Format the inline review comments section. Returns empty string if none. */
function formatInlineComments(
  inlineComments: InlineCommentData[] | undefined,
  opts: FormatOptions,
): string {
  if (!inlineComments || inlineComments.length === 0) return "";
  const header = `=== INLINE REVIEW COMMENTS (${inlineComments.length}) ===`;
  const entries = inlineComments.map(
    (c) =>
      `[${oneLine(c.user?.login ?? "unknown", opts)}] ${oneLine(c.path, opts, 500)}:${c.line ?? ""}\n${bodyOf("review-comment", c.body, c.user?.login, opts)}`,
  );
  return [header, ...entries].join("\n");
}

/** Format the diff section. Returns empty string if no diff. */
function formatDiff(diff: string | null | undefined, opts: FormatOptions): string {
  if (!diff) return "";
  // NFC, not NFKC: folding compatibility characters would change the code under review.
  return `=== DIFF ===\n${fenced("diff", null, diff, opts, { maxLength: DIFF_LIMIT, normalization: "NFC" })}`;
}

/** Format the triggering comment section. */
function formatTriggeringComment(body: string, opts: FormatOptions): string {
  return `=== TRIGGERING COMMENT ===\n${bodyOf("triggering-comment", body, opts.triggeringAuthor, opts)}`;
}

/**
 * Format fetched context data into labeled plaintext sections. Include
 * UNTRUSTED_PREAMBLE once in any prompt that carries the result.
 */
export function formatContext(data: ContextData, opts: FormatOptions): string {
  const { type, number, triggeringComment } = opts;
  const sections: string[] = [];

  if (type === "issue") {
    if (data.issue) sections.push(formatIssueHeader(data.issue, number, opts));
    const comments = formatComments(data.comments, opts);
    if (comments) sections.push(comments);
  } else if (type === "pr-diff") {
    if (data.pr) sections.push(formatPRHeader(data.pr, number, opts));
    const diff = formatDiff(data.diff, opts);
    if (diff) sections.push(diff);
  } else if (type === "pr-review" || type === "pr-full") {
    if (data.pr) sections.push(formatPRHeader(data.pr, number, opts));
    const comments = formatComments(data.comments, opts);
    if (comments) sections.push(comments);
    const reviews = formatReviews(data.reviews, opts);
    if (reviews) sections.push(reviews);
    const inlineComments = formatInlineComments(data.inlineComments, opts);
    if (inlineComments) sections.push(inlineComments);
    const diff = formatDiff(data.diff, opts);
    if (diff) sections.push(diff);
  }

  if (triggeringComment) {
    sections.push(formatTriggeringComment(triggeringComment, opts));
  }

  return sections.join("\n\n");
}
