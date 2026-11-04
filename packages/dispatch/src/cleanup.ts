// The nightly cleanup's policy (P1-13 slice 2, ADR-0020): pure code, no I/O. cleanup-step.ts reads and writes.
//
// Everything here fails toward keeping. A preview tag or authorized domain is an orphan only if GitHub says, right
// now, that its PR closed over an hour ago. Claims go only for a PR closed for a week with no open hold, and a ledger
// goes only if it's empty too: one that records a review is the shadow index and the PR's budget.
// Names match exactly or not at all, and anything that doesn't is left alone.
import { addUsd, type ReviewLedger } from "@globalhost/core";

/** The workflow's own teardown runs on close, so anything younger could still be in its hands. */
export const ORPHAN_MIN_CLOSED_MS = 60 * 60_000;
/** How long a closed PR keeps its claims, and its ledger if that's empty. */
export const REVIEW_STATE_RETENTION_DAYS = 7;
/** A review reservation this old, on a closed PR, is a crashed run: far longer than any job. */
export const RELEASE_RESERVATION_AFTER_HOURS = 24;
/** A dead session's dispatch hold. Past the watcher's 24 hours, so it's red for a night before it's released. */
export const RELEASE_DISPATCH_HOLD_AFTER_HOURS = 48;
/** Tags, domains, closed PRs' claims and empty ledgers, and releases, together. Above it nothing is touched: it means a bug. */
export const MAX_CHANGES_PER_RUN = 20;
export const PREVIEW_ZONE = "globalhost.ai";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Canonical decimal only, up to 10 digits: `pr-0`, `pr-007`, `pr-1x` and `pr-1-canary` aren't ours. */
const PR_DIGITS = /^[1-9][0-9]{0,9}$/;

/** The PR number of a tag that is exactly `pr-<n>`, or null. */
export function prFromTag(tag: string): number | null {
  if (!tag.startsWith("pr-")) return null;
  const digits = tag.slice(3);
  return PR_DIGITS.test(digits) ? Number(digits) : null;
}

/** The PR number of a domain that is exactly `<product>-<part>-pr-<n>.globalhost.ai`, or null. */
export function prFromDomain(domain: string, product: string, part: string): number | null {
  const prefix = `${product}-${part}-pr-`;
  const suffix = `.${PREVIEW_ZONE}`;
  if (!domain.startsWith(prefix) || !domain.endsWith(suffix)) return null;
  const digits = domain.slice(prefix.length, domain.length - suffix.length);
  return PR_DIGITS.test(digits) ? Number(digits) : null;
}

/** What GitHub says about a number. Anything but a clean answer is `unknown`. */
export type PrTruth =
  | { kind: "open" }
  | { kind: "closed"; closedAtMs: number; /** GitHub's casing: spend records keep it. */ repo: string }
  | { kind: "unknown"; /** Fixed text or an HTTP status, for a public log. */ why: string };

export type PreviewVerdict = "orphan" | "open" | "closed-recently" | "unknown";

/** Strictly more than the hour, so exactly an hour keeps. */
export function previewVerdict(truth: PrTruth, nowMs: number): PreviewVerdict {
  if (truth.kind === "open") return "open";
  if (truth.kind === "unknown") return "unknown";
  return nowMs - truth.closedAtMs > ORPHAN_MIN_CLOSED_MS ? "orphan" : "closed-recently";
}

export interface TrafficEntry {
  type?: string | undefined;
  percent?: number | undefined;
  tag?: string | undefined;
}

/** A tag entry is removable only if it's a pinned revision with no traffic, as the preview workflow deploys it. */
export function isRemovableTagEntry(entry: TrafficEntry): boolean {
  return entry.type === "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION" && (entry.percent ?? 0) === 0;
}

/** The traffic list without these tags. Entries are kept whole, and only removable ones ever go. */
export function trafficWithout<T extends TrafficEntry>(traffic: readonly T[], tags: ReadonlySet<string>): T[] {
  return traffic.filter((e) => !(e.tag !== undefined && tags.has(e.tag) && isRemovableTagEntry(e)));
}

/**
 * A ledger holding nothing but open reservations. One with any review in it stays until P2-01c sets its retention:
 * its `runs` are the shadow index, and its total is the PR's budget if the PR reopens (ADR-0020).
 */
export function isEmptyLedger(ledger: Pick<ReviewLedger, "runs" | "reviewSpendUsd">): boolean {
  return ledger.runs.length === 0 && ledger.reviewSpendUsd === 0;
}

export interface ReviewPlan {
  /** Reservations to release. */
  release: string[];
  deleteClaims: boolean;
  deleteLedger: boolean;
  /** Why it's kept, when that needs saying. An open PR, or a recently closed one, is just normal. */
  kept?: string;
}

/** What to do with one PR's review state. `ledger` is null when it has claims only. */
export function planReviewPr(truth: PrTruth, ledger: ReviewLedger | null | "corrupt", nowMs: number): ReviewPlan {
  const none = { release: [], deleteClaims: false, deleteLedger: false };
  if (truth.kind === "open") return none;
  if (truth.kind === "unknown") return { ...none, kept: truth.why };
  if (ledger === "corrupt") return { ...none, kept: "its ledger is corrupt" };
  const reservations = ledger?.reservations ?? [];
  const staleBefore = nowMs - RELEASE_RESERVATION_AFTER_HOURS * HOUR_MS;
  const release = reservations.filter((r) => Date.parse(r.reservedAt) < staleBefore).map((r) => r.runId);
  const open = reservations.length - release.length;
  if (nowMs - truth.closedAtMs < REVIEW_STATE_RETENTION_DAYS * DAY_MS) return { ...none, release };
  if (open > 0) return { ...none, release, kept: "an open reservation is under 24 hours old" };
  return { release, deleteClaims: true, deleteLedger: ledger !== null && isEmptyLedger(ledger) };
}

/** Whether a dead session's hold is old enough to release. An unparseable time is kept. */
export function dispatchHoldReleasable(at: string, nowMs: number): boolean {
  const ms = Date.parse(at);
  return !Number.isNaN(ms) && nowMs - ms > RELEASE_DISPATCH_HOLD_AFTER_HOURS * HOUR_MS;
}

/** The cap, at most: exactly MAX_CHANGES_PER_RUN goes ahead. */
export const overCap = (changes: number): boolean => changes > MAX_CHANGES_PER_RUN;

/** One thing left alone. PR numbers and fixed text only, because this reaches a public log. */
export interface Kept {
  what: "preview tag" | "authorized domain" | "review state";
  pr: number;
  why: string;
}

export interface CleanupReport {
  mode: "apply" | "dry-run";
  /** The plan was over MAX_CHANGES_PER_RUN, so nothing was changed. */
  overCap: boolean;
  /** Why CLEANUP_APPLY didn't apply: the kill switch is on, or it couldn't be read. */
  dryRunReason?: "paused" | "pause-unreadable";
  planned: number;
  /** PR numbers, done (or, in a dry run, what would be done). */
  tags: number[];
  domains: number[];
  reviewState: number[];
  /** Held amounts: released without settling, so the session may have spent up to these. */
  reservations: { pr: number; usd: number }[];
  dispatchHolds: { usd: number }[];
  kept: Kept[];
  /** Fixed text and HTTP statuses only. Any of these fails the job. */
  failures: string[];
}

const list = (prs: readonly number[]) => (prs.length === 0 ? "none" : [...new Set(prs)].sort((a, b) => a - b).map((n) => `#${n}`).join(", "));

/** The log lines and job summary. Built only from PR numbers, amounts and fixed text: the Actions log is public. */
export function renderCleanupReport(r: CleanupReport): string {
  const verb = r.mode === "apply" ? "Removed" : "Would remove";
  const release = r.mode === "apply" ? "Released" : "Would release";
  const held = addUsd(...r.reservations.map((x) => x.usd), ...r.dispatchHolds.map((x) => x.usd));
  const lines = [
    `## Cleanup (${r.mode === "apply" ? "applied" : "dry run: nothing was changed"})`,
    "",
    ...(r.dryRunReason === "paused" ? ["**The factory is paused, so this is a dry run whatever `CLEANUP_APPLY` says.**", ""] : []),
    ...(r.dryRunReason === "pause-unreadable" ? ["**The kill switch couldn't be read, so this is a dry run whatever `CLEANUP_APPLY` says.**", ""] : []),
    ...(r.overCap ? [`**Over the cap: ${r.planned} changes planned, the limit is ${MAX_CHANGES_PER_RUN}. Nothing was changed.** The counts below are the plan.`, ""] : []),
    `- ${verb} preview tags: ${list(r.tags)}`,
    `- ${verb} authorized domains: ${list(r.domains)}`,
    `- ${verb} review claims and empty ledgers: ${list(r.reviewState)}`,
    `- ${release} review reservations: ${list(r.reservations.map((x) => x.pr))}`,
    `- ${release} dead session holds: ${r.dispatchHolds.length}`,
    ...(held > 0 ? [`- Held amount: $${held.toFixed(2)}. Not in the ledger, and those sessions may have spent up to it.`] : []),
  ];
  if (r.kept.length > 0) {
    lines.push("", "### Kept", "");
    for (const k of r.kept) lines.push(`- ${k.what} of #${k.pr}: ${k.why}`);
  }
  if (r.failures.length > 0) {
    lines.push("", "### Failures", "");
    for (const f of r.failures) lines.push(`- ${f}`);
  }
  return `${lines.join("\n")}\n`;
}
