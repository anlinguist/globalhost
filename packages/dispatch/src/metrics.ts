// Factory metrics and the budget watcher (P1-13, ADR-0020): pure code, no I/O. metrics-step.ts reads and publishes.
//
// Everything this produces is public: the rendered report goes to an issue in a public repo. So the only things
// taken from a run.json are numbers, enums and a repo name that passes the slug check. `report`, `problems`,
// `stopReason`, `model`, `outputIssues` and every other free-text field are parsed for validity and dropped. A
// repo that isn't confirmed public is reported as OTHER_REPO, in every table and every finding.
import { addUsd, DEFAULT_DAILY_USD, ReviewLedgerSchema } from "@globalhost/core";
import { ReviewRunSchema, RunRecordSchema } from "@globalhost/runner";
import { z } from "zod";
import { isRepoSlug } from "./gcp.js";

/** The factory's budget month starts on the day the credit lands (ADR-0004). */
export const BUDGET_CYCLE_START_DAY = 10;
/** The `globalhost-runners` workspace limit per cycle (ADR-0004). */
export const BUDGET_CYCLE_CAP_USD = 150;
/** Share of the cap, and of the daily limit, that trips the watcher. */
export const WATCH_SHARE = 0.8;
/** A projection means little earlier in the cycle than this. */
export const PROJECTION_MIN_DAYS = 5;
/** The projection's pace is the average over this many trailing complete days, or as many as the cycle has had. */
export const PROJECTION_PACE_DAYS = 7;
/** Run records and the ledger are compared over this many complete days, not per day (midnight attribution). */
export const DRIFT_WINDOW_DAYS = 7;
export const DRIFT_MIN_USD = 1;
export const DRIFT_SHARE = 0.1;
/** A review reservation is settled when its run ends; this is far longer than any run. */
export const RESERVATION_MAX_AGE_HOURS = 24;
/** The lifecycle rule on globalhost-runs. Older run records are gone; the ledger keeps its spend. */
export const RUN_RECORD_RETENTION_DAYS = 30;
/** What private repos and repos the token can't read are reported as. */
export const OTHER_REPO = "other";

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => toDay(dayMs(day) + n * DAY_MS);
const cents = (amount: number) => Math.round(amount * 100);

/** A real calendar day in YYYY-MM-DD, not just the shape of one. */
function isDay(s: string): boolean {
  return DAY.test(s) && !Number.isNaN(dayMs(s)) && toDay(dayMs(s)) === s;
}

/** The UTC day before `now`: the newest day whose numbers can't change any more. */
export const lastCompleteDay = (now: Date): string => toDay(now.getTime() - DAY_MS);

export interface BudgetCycle {
  /** First day, inclusive: the 10th. */
  start: string;
  /** Last day, inclusive: the 9th of the next month. */
  end: string;
  lengthDays: number;
}

/** The budget cycle containing `day`: days 1-9 of a month belong to the cycle that began on the 10th before. */
export function budgetCycle(day: string): BudgetCycle {
  const d = new Date(`${day}T00:00:00Z`);
  const month = d.getUTCMonth() - (d.getUTCDate() < BUDGET_CYCLE_START_DAY ? 1 : 0);
  const startMs = Date.UTC(d.getUTCFullYear(), month, BUDGET_CYCLE_START_DAY);
  const nextMs = Date.UTC(d.getUTCFullYear(), month + 1, BUDGET_CYCLE_START_DAY);
  return { start: toDay(startMs), end: toDay(nextMs - DAY_MS), lengthDays: Math.round((nextMs - startMs) / DAY_MS) };
}

/**
 * The days the step must read spend records for: the current cycle and the drift window, through today. Today's
 * record isn't counted in any total, but a corrupt one is reported, because it stops the repo's runs right now.
 */
export function spendWindow(now: Date): { from: string; to: string } {
  const day = lastCompleteDay(now);
  const start = budgetCycle(day).start;
  const drift = addDays(day, 1 - DRIFT_WINDOW_DAYS);
  return { from: start < drift ? start : drift, to: toDay(now.getTime()) };
}

// ---- Parsing ----

export interface StoredObject {
  name: string;
  body: string;
}

export type RunRole = "planner" | "builder" | "assessor" | "reviewer";
const ROLES: readonly RunRole[] = ["planner", "builder", "assessor", "reviewer"];

/** One archived run.json, reduced to what metrics may use. */
export interface RunEvent {
  /** Lowercased, slug-checked. Builder and review archives spell the same repo differently. */
  repo: string;
  role: RunRole;
  /** The UTC day it finished. */
  day: string;
  /** What this turn added. `costUsd` is cumulative per session, so a later turn counts only its difference. */
  usd: number;
  /** A builder turn after the first: resumed with owner feedback. */
  redirect: boolean;
  /** The issue a planner or builder worked on (its branch is `factory/issue-<n>`). */
  issue: number | null;
  /** The PR a review was for. */
  pr: number | null;
  /** A later turn whose earlier turns are gone, so its cost can't be split out. */
  noBaseline: boolean;
}

export interface UnrecognizedRun {
  /** The object name, for the private problems file only. Never rendered: it can name a private repo. */
  name: string;
  /** The lowercased repo from the object name, when it has one. */
  repo: string | null;
}

export interface ParsedRuns {
  events: RunEvent[];
  unrecognized: UnrecognizedRun[];
}

const BUILDER_PATH = /^[^/]+\/[^/]+\/([^/]+)\/turn-([1-9][0-9]*)\/run\.json$/;
const REVIEW_PATH = /^[^/]+\/[^/]+\/reviews\/pr-([1-9][0-9]*)\/[0-9a-f]+\/([^/]+)\/run\.json$/;

interface TurnRecord {
  repo: string;
  role: RunRole;
  turn: number;
  issue: number | null;
  costUsd: number;
  day: string;
}

const validCost = (amount: number) => Number.isFinite(amount) && amount >= 0;

function finishedDay(finishedAt: string): string | null {
  const ms = Date.parse(finishedAt);
  return Number.isNaN(ms) ? null : toDay(ms);
}

/** The repo named by a run archive path, lowercased, or null if it isn't a slug. */
function pathRepo(name: string): string | null {
  const repo = name.split("/").slice(0, 2).join("/").toLowerCase();
  return isRepoSlug(repo) ? repo : null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A review is one session per runId, so its whole cost is its own. Null when it doesn't match its object name. */
function reviewEvent(repo: string, match: RegExpExecArray, raw: unknown): RunEvent | null {
  const parsed = ReviewRunSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { data } = parsed;
  const day = finishedDay(data.finishedAt);
  if (!day || !validCost(data.costUsd) || data.repo.toLowerCase() !== repo || data.pr !== Number(match[1]) || data.runId !== match[2]) return null;
  return { repo, role: "reviewer", day, usd: data.costUsd, redirect: false, issue: data.issue, pr: data.pr, noBaseline: false };
}

/** One turn of a planner, builder or assessor run. Null when it doesn't match its object name. */
function turnRecord(repo: string, match: RegExpExecArray, raw: unknown): (TurnRecord & { runId: string }) | null {
  const parsed = RunRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { data } = parsed;
  const day = finishedDay(data.finishedAt);
  if (!day || !validCost(data.costUsd) || data.repo.toLowerCase() !== repo || data.runId !== match[1] || data.turn !== Number(match[2])) return null;
  return { repo, runId: data.runId, role: data.role, turn: data.turn, issue: data.issue, costUsd: data.costUsd, day };
}

/**
 * Parses every archived run.json. One that doesn't match its layout and schema, or whose fields disagree with its
 * object name, is returned as unrecognized and costs nothing: the watcher reports it, so it's never silently lost.
 */
export function parseRuns(objects: readonly StoredObject[]): ParsedRuns {
  const events: RunEvent[] = [];
  const unrecognized: UnrecognizedRun[] = [];
  const turns = new Map<string, TurnRecord[]>();

  for (const { name, body } of objects) {
    const repo = pathRepo(name);
    const review = REVIEW_PATH.exec(name);
    const builder = review ? null : BUILDER_PATH.exec(name);
    if (!repo || (!review && !builder)) {
      unrecognized.push({ name, repo });
      continue;
    }
    const raw = parseJson(body);
    if (review) {
      const event = reviewEvent(repo, review, raw);
      if (event) events.push(event);
      else unrecognized.push({ name, repo });
      continue;
    }
    const turn = turnRecord(repo, builder!, raw);
    if (!turn) {
      unrecognized.push({ name, repo });
      continue;
    }
    const key = `${repo}\0${turn.runId}`;
    turns.set(key, [...(turns.get(key) ?? []), turn]);
  }

  for (const list of turns.values()) {
    list.sort((a, b) => a.turn - b.turn);
    let previous: number | null = null;
    for (const t of list) {
      // The first archive we have is a later turn: turn 1 aged out or was never archived, so the cost before this
      // turn is unknown. Counting the cumulative figure would overstate it, so it adds nothing and is noted.
      const noBaseline = previous === null && t.turn > 1;
      const added = noBaseline ? 0 : Math.max(0, t.costUsd - (previous ?? 0));
      previous = Math.max(previous ?? 0, t.costUsd);
      events.push({ repo: t.repo, role: t.role, day: t.day, usd: added, redirect: t.role === "builder" && t.turn > 1, issue: t.issue, pr: null, noBaseline });
    }
  }
  return { events, unrecognized };
}

const isoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)));

const SpendRecordSchema = z.object({
  usd: z.number().nonnegative().default(0),
  // Written capped at 200 and never needed here: `usd` is the complete total. Only the shape is checked.
  runs: z.array(z.unknown()).default([]),
  reservations: z.array(z.object({ runId: z.string().optional(), usd: z.number().nonnegative(), at: isoTime })).default([]),
  released: z.array(z.object({ usd: z.number().nonnegative(), releasedAt: isoTime })).default([]),
});

export interface SpendRow {
  day: string;
  repo: string;
  usd: number;
  reservations: { runId?: string | undefined; usd: number; at: string }[];
  /** Holds cleanup.yml dropped without settling: the session may have spent up to `usd`. */
  released: { usd: number; releasedAt: string }[];
}

export interface CorruptSpend {
  name: string;
  /** Null when the object name itself is malformed. */
  day: string | null;
  repo: string | null;
}

export interface ParsedSpend {
  rows: SpendRow[];
  corrupt: CorruptSpend[];
}

const SPEND_PATH = /^spend\/([^/]+)\/([^/]+)\.json$/;

/** `spend/<day>/<owner>__<name>.json` → day and lowercased repo. An owner can't contain `_`, so the first `__` splits it. */
export function parseSpendName(name: string): { day: string; repo: string } | null {
  const m = SPEND_PATH.exec(name);
  if (!m || !isDay(m[1]!) || !m[2]!.includes("__")) return null;
  const repo = m[2]!.replace("__", "/").toLowerCase();
  return isRepoSlug(repo) ? { day: m[1]!, repo } : null;
}

export function parseSpend(objects: readonly StoredObject[]): ParsedSpend {
  const rows: SpendRow[] = [];
  const corrupt: CorruptSpend[] = [];
  for (const { name, body } of objects) {
    const key = parseSpendName(name);
    const parsed = key ? SpendRecordSchema.safeParse(parseJson(body)) : undefined;
    if (!key || !parsed?.success) {
      corrupt.push({ name, day: key?.day ?? null, repo: key?.repo ?? null });
      continue;
    }
    rows.push({ day: key.day, repo: key.repo, usd: parsed.data.usd, reservations: parsed.data.reservations, released: parsed.data.released });
  }
  return { rows, corrupt };
}

/** `reviews/<repo>/pr-<n>.json`, the PR's review ledger. Claims sit in a `pr-<n>/` folder beside it. */
export const REVIEW_LEDGER_PATH = /^reviews\/([^/]+\/[^/]+)\/pr-[1-9][0-9]*\.json$/;

export interface LedgerHold {
  /** The object name, for the private problems file only. */
  name: string;
  repo: string;
  runId: string;
  usd: number;
  at: string;
}

export interface ParsedLedgers {
  holds: LedgerHold[];
  /** A corrupt ledger stops that PR's reviews. `name` is for the private problems file only. */
  corrupt: { name: string; repo: string }[];
}

export function parseLedgers(objects: readonly StoredObject[]): ParsedLedgers {
  const holds: LedgerHold[] = [];
  const corrupt: ParsedLedgers["corrupt"] = [];
  for (const { name, body } of objects) {
    const repo = REVIEW_LEDGER_PATH.exec(name)?.[1]?.toLowerCase();
    if (!repo || !isRepoSlug(repo)) continue;
    const parsed = ReviewLedgerSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      corrupt.push({ name, repo });
      continue;
    }
    for (const r of parsed.data.reservations) holds.push({ name, repo, runId: r.runId, usd: r.reservedUsd, at: r.reservedAt });
  }
  return { holds, corrupt };
}

/** Ledger holds older than the reservation limit. */
export function staleLedgerHolds(ledgers: ParsedLedgers, now: Date): LedgerHold[] {
  const cutoff = now.getTime() - RESERVATION_MAX_AGE_HOURS * 3_600_000;
  return ledgers.holds.filter((h) => Date.parse(h.at) < cutoff);
}

// ---- Aggregating ----

export interface RepoInfo {
  /** Confirmed public. Anything else (private, unreadable, an error asking) is rolled up as OTHER_REPO. */
  public: boolean;
  /** The UTC days factory PRs merged, one entry per PR; null when it couldn't be determined. */
  mergedDays: string[] | null;
}

export interface PeriodMetrics {
  runs: Record<RunRole, number>;
  totalRuns: number;
  /** From the ledger. */
  spendUsd: number;
  usdPerRun: number | null;
  /** Builder turns after the first. */
  redirects: number;
  /** Distinct `factory/issue-<n>` branches builders worked on. */
  prsBuilt: number;
  redirectsPerPr: number | null;
  /** From review run records. */
  reviewUsd: number;
  prsReviewed: number;
  reviewUsdPerPr: number | null;
  /** Factory PRs merged; null when no repo in this row could be counted. */
  mergedPrs: number | null;
  /** Ledger spend of the repos that could be counted, over their merged PRs. */
  usdPerMergedPr: number | null;
}

export type FindingCode =
  | "cycle-spend"
  | "cycle-projection"
  | "daily-spend"
  | "ledger-drift"
  | "corrupt-spend"
  | "corrupt-ledger"
  | "unrecognized-run"
  | "stale-reservation";

export interface Finding {
  code: FindingCode;
  message: string;
}

export interface MetricsReport {
  version: 1;
  /** The last complete UTC day, which every total runs through. */
  day: string;
  generatedAt: string;
  cycle: BudgetCycle & {
    elapsedDays: number;
    capUsd: number;
    spendUsd: number;
    /** Spend so far plus the recent pace over the days left. Null until PROJECTION_MIN_DAYS have elapsed. */
    projectedUsd: number | null;
    /** The days the pace was averaged over: PROJECTION_PACE_DAYS, fewer early in a cycle. */
    projectionPaceDays: number;
    /** The cycle reaches back further than run records last, so its run-derived numbers may be low. */
    runRecordsExpiring: boolean;
    /** Holds cleanup.yml released this cycle, from the records read: never in the ledger, possibly spent. */
    released: { count: number; usd: number };
    metrics: PeriodMetrics;
  };
  byRepo: { repo: string; metrics: PeriodMetrics }[];
  days: { day: string; metrics: PeriodMetrics }[];
  drift: {
    from: string;
    to: string;
    ledgerUsd: number;
    runRecordsUsd: number;
    /** Each repo's difference, absolute, added up: one repo's excess can't hide another's shortfall. */
    diffUsd: number;
    allowedUsd: number;
    /** A resumed turn in the window has no earlier turn on record, so the run-record side is known to be short. */
    unknownBaseline: boolean;
  };
  dailyLimitUsd: number;
  notes: { runsWithoutBaseline: number; reposWithoutMergeCount: number };
  findings: Finding[];
}

export interface AggregateInput {
  now: Date;
  runs: ParsedRuns;
  spend: ParsedSpend;
  repos: ReadonlyMap<string, RepoInfo>;
  /** The PR ledgers' holds. They outlast the spend window, so the watcher reads them as well. */
  ledgers?: ParsedLedgers;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const usd = (n: number) => `$${n.toFixed(2)}`;
const distinct = (items: readonly string[]) => new Set(items).size;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function aggregateMetrics({ now, runs, spend, repos, ledgers = { holds: [], corrupt: [] } }: AggregateInput): MetricsReport {
  const day = lastCompleteDay(now);
  const cycle = budgetCycle(day);
  const label = (repo: string | null) => (repo !== null && repos.get(repo)?.public === true ? repo : OTHER_REPO);
  const inCycle = (d: string) => d >= cycle.start && d <= day;

  const period = (from: string, to: string, repoLabel?: string): PeriodMetrics => {
    const within = (d: string) => d >= from && d <= to;
    const forRepo = (repo: string) => repoLabel === undefined || label(repo) === repoLabel;
    const events = runs.events.filter((e) => within(e.day) && forRepo(e.repo));
    const rows = spend.rows.filter((r) => within(r.day) && forRepo(r.repo));
    const count = Object.fromEntries(ROLES.map((role) => [role, events.filter((e) => e.role === role).length])) as Record<RunRole, number>;
    const spendUsd = addUsd(...rows.map((r) => r.usd));
    const builds = events.filter((e) => e.role === "builder" && e.issue !== null);
    const reviews = events.filter((e) => e.role === "reviewer");
    const redirects = events.filter((e) => e.redirect).length;
    const prsBuilt = distinct(builds.map((e) => `${e.repo}#${e.issue}`));
    const reviewUsd = addUsd(...reviews.map((e) => e.usd));
    const prsReviewed = distinct(reviews.map((e) => `${e.repo}#${e.pr}`));

    // Only public repos are asked about merges, so `other` has no count, and its spend stays out of the ratio.
    const counted = (repo: string) => forRepo(repo) && repos.get(repo)?.public === true && repos.get(repo)?.mergedDays != null;
    const countedRepos = [...repos.keys()].filter(counted);
    const mergedPrs = countedRepos.length === 0 ? null : countedRepos.flatMap((r) => repos.get(r)!.mergedDays!).filter(within).length;
    const countedSpend = addUsd(...rows.filter((r) => counted(r.repo)).map((r) => r.usd));
    const totalRuns = events.length;
    return {
      runs: count,
      totalRuns,
      spendUsd,
      usdPerRun: ratio(spendUsd, totalRuns),
      redirects,
      prsBuilt,
      redirectsPerPr: ratio(redirects, prsBuilt),
      reviewUsd,
      prsReviewed,
      reviewUsdPerPr: ratio(reviewUsd, prsReviewed),
      mergedPrs,
      usdPerMergedPr: mergedPrs === null ? null : ratio(countedSpend, mergedPrs),
    };
  };

  const metrics = period(cycle.start, day);
  const elapsedDays = Math.round((dayMs(day) - dayMs(cycle.start)) / DAY_MS) + 1;
  const spendUsd = metrics.spendUsd;
  const findings: Finding[] = [];

  // (a) Cycle spend against the cap. Compared in cents, so exactly 80% of the cap trips it.
  const spendCents = cents(spendUsd);
  const capCents = cents(BUDGET_CYCLE_CAP_USD);
  if (spendCents >= capCents * WATCH_SHARE) {
    findings.push({
      code: "cycle-spend",
      message: `Cycle spend ${usd(spendUsd)} has reached ${usd(BUDGET_CYCLE_CAP_USD * WATCH_SHARE)}, ${WATCH_SHARE * 100}% of the ${usd(BUDGET_CYCLE_CAP_USD)} cap.`,
    });
  }

  // (b) Spend so far plus the recent pace over the days left, so a burst counts in full however quiet the cycle's
  // start was. The window stays inside the cycle, so it's never empty, and last cycle's spend sets no pace here.
  // Compared without dividing.
  const projectionPaceDays = Math.min(PROJECTION_PACE_DAYS, elapsedDays);
  const paceFrom = addDays(day, 1 - projectionPaceDays);
  const paceUsd = addUsd(...spend.rows.filter((r) => r.day >= paceFrom && r.day <= day).map((r) => r.usd));
  const daysLeft = cycle.lengthDays - elapsedDays;
  const projectedUsd = elapsedDays >= PROJECTION_MIN_DAYS ? spendUsd + (paceUsd / projectionPaceDays) * daysLeft : null;
  if (projectedUsd !== null && spendCents * projectionPaceDays + cents(paceUsd) * daysLeft > capCents * projectionPaceDays) {
    findings.push({
      code: "cycle-projection",
      message: `At the last ${projectionPaceDays} days' pace the cycle ends at ${usd(projectedUsd)}, over the ${usd(BUDGET_CYCLE_CAP_USD)} cap (${usd(spendUsd)} so far, ${usd(paceUsd)} of it in those days, ${daysLeft} days left).`,
    });
  }

  // (c) The last complete day, all repos together, against the default per-repo limit: the stricter reading.
  const dayUsd = addUsd(...spend.rows.filter((r) => r.day === day).map((r) => r.usd));
  if (cents(dayUsd) >= cents(DEFAULT_DAILY_USD) * WATCH_SHARE) {
    findings.push({
      code: "daily-spend",
      message: `Spend on ${day} was ${usd(dayUsd)}, at or over ${usd(DEFAULT_DAILY_USD * WATCH_SHARE)}, ${WATCH_SHARE * 100}% of the ${usd(DEFAULT_DAILY_USD)} daily limit.`,
    });
  }

  // (d) Run records against the ledger, over a window so a run that crosses midnight mid-window doesn't count as
  // drift. This only sees a gap between the two records: a builder killed mid-session writes neither (ADR-0020).
  const driftFrom = addDays(day, 1 - DRIFT_WINDOW_DAYS);
  const inDrift = (d: string) => d >= driftFrom && d <= day;
  const windowRows = spend.rows.filter((r) => inDrift(r.day));
  const windowEvents = runs.events.filter((e) => inDrift(e.day));
  const ledgerUsd = addUsd(...windowRows.map((r) => r.usd));
  const runRecordsUsd = addUsd(...windowEvents.map((e) => e.usd));
  const diffCents = [...new Set([...windowRows.map((r) => r.repo), ...windowEvents.map((e) => e.repo)])]
    .map((repo) => {
      const ledger = addUsd(...windowRows.filter((r) => r.repo === repo).map((r) => r.usd));
      const records = addUsd(...windowEvents.filter((e) => e.repo === repo).map((e) => e.usd));
      return Math.abs(cents(ledger) - cents(records));
    })
    .reduce((sum, d) => sum + d, 0);
  const unknownBaseline = windowEvents.some((e) => e.noBaseline);
  const drift = {
    from: driftFrom,
    to: day,
    ledgerUsd,
    runRecordsUsd,
    diffUsd: diffCents / 100,
    allowedUsd: Math.max(DRIFT_MIN_USD, ledgerUsd * DRIFT_SHARE),
    unknownBaseline,
  };
  if (!unknownBaseline && diffCents > cents(DRIFT_MIN_USD) && diffCents > cents(ledgerUsd) * DRIFT_SHARE) {
    findings.push({
      code: "ledger-drift",
      message:
        `Run records and the ledger differ by ${usd(drift.diffUsd)}, added up per repo, from ${driftFrom} to ${day} (run records ${usd(runRecordsUsd)}, ledger ${usd(ledgerUsd)}; ` +
        `allowed ${usd(drift.allowedUsd)}). Possible causes: a failed review settled up to its cap with no run.json, which stays red until it leaves the window; a run crossing midnight at the window's edge, which clears in a day; ` +
        `a job that stopped between recording spend and archiving. A builder killed mid-session doesn't show here: it shows as an open reservation, and only the Console knows its spend.`,
    });
  }

  // (e) Records that couldn't be used. Named by day and report label only: the object name can name a private repo.
  if (ledgers.corrupt.length > 0) {
    const where = [...new Set(ledgers.corrupt.map((c) => label(c.repo)))].sort().join(", ");
    findings.push({
      code: "corrupt-ledger",
      message: `${plural(ledgers.corrupt.length, "PR review ledger is", "PR review ledgers are")} corrupt (${where}). A corrupt ledger stops that PR's reviews, and cleanup leaves it for the owner.`,
    });
  }
  if (spend.corrupt.length > 0) {
    const where = [...new Set(spend.corrupt.map((c) => `${c.day ?? "unknown day"} (${label(c.repo)})`))].sort().join(", ");
    findings.push({
      code: "corrupt-spend",
      message: `${plural(spend.corrupt.length, "spend record is", "spend records are")} corrupt and left out of the totals: ${where}. A corrupt record for today stops that repo's runs.`,
    });
  }
  if (runs.unrecognized.length > 0) {
    const counts = new Map<string, number>();
    for (const u of runs.unrecognized) counts.set(label(u.repo), (counts.get(label(u.repo)) ?? 0) + 1);
    const where = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([repo, n]) => `${repo}: ${n}`).join(", ");
    findings.push({
      code: "unrecognized-run",
      message: `${plural(runs.unrecognized.length, "run.json fails", "run.json files fail")} the schema and ${runs.unrecognized.length === 1 ? "is" : "are"} left out of the totals (${where}).`,
    });
  }

  // (f) A settled run removes its reservation, so an old one is a run that crashed. A review's hold is on both its
  // day's record and its PR's ledger, and the ledger has no window, so holds from before the window show too.
  const cutoff = now.getTime() - RESERVATION_MAX_AGE_HOURS * 3_600_000;
  const onDays = spend.rows.flatMap((r) => r.reservations.filter((x) => Date.parse(x.at) < cutoff).map((x) => ({ usd: x.usd, repo: r.repo, runId: x.runId })));
  const seenHolds = new Set(onDays.map((h) => `${h.repo}\0${h.runId}`));
  const stale = [...onDays, ...staleLedgerHolds(ledgers, now).filter((h) => !seenHolds.has(`${h.repo}\0${h.runId}`))];
  if (stale.length > 0) {
    const where = [...new Set(stale.map((s) => label(s.repo)))].sort().join(", ");
    findings.push({
      code: "stale-reservation",
      message: `${plural(stale.length, "open reservation is", "open reservations are")} older than ${RESERVATION_MAX_AGE_HOURS} hours, holding ${usd(addUsd(...stale.map((s) => s.usd)))} (${where}). Each is a review or builder session that died without settling. \`cleanup.yml\` releases a closed PR's and a dead builder's; one on an open PR stays until the owner clears it.`,
    });
  }

  const cycleRepos = [...runs.events.filter((e) => inCycle(e.day)).map((e) => e.repo), ...spend.rows.filter((r) => inCycle(r.day)).map((r) => r.repo)];
  const labels = [...new Set(cycleRepos.map((r) => label(r)))].sort((a, b) => (a === OTHER_REPO ? 1 : b === OTHER_REPO ? -1 : a.localeCompare(b)));

  const released = spend.rows.flatMap((r) => r.released).filter((x) => inCycle(toDay(Date.parse(x.releasedAt))));

  const days: MetricsReport["days"] = [];
  for (let d = cycle.start; d <= day; d = addDays(d, 1)) days.push({ day: d, metrics: period(d, d) });

  return {
    version: 1,
    day,
    generatedAt: now.toISOString(),
    cycle: {
      ...cycle,
      elapsedDays,
      capUsd: BUDGET_CYCLE_CAP_USD,
      spendUsd,
      projectedUsd,
      projectionPaceDays,
      runRecordsExpiring: now.getTime() - dayMs(cycle.start) >= RUN_RECORD_RETENTION_DAYS * DAY_MS,
      released: { count: released.length, usd: addUsd(...released.map((x) => x.usd)) },
      metrics,
    },
    byRepo: labels.map((repo) => ({ repo, metrics: period(cycle.start, day, repo) })),
    days,
    drift,
    dailyLimitUsd: DEFAULT_DAILY_USD,
    notes: {
      runsWithoutBaseline: runs.events.filter((e) => e.noBaseline && inCycle(e.day)).length,
      reposWithoutMergeCount: [...repos.values()].filter((r) => r.public && r.mergedDays === null).length,
    },
    findings,
  };
}

// ---- Rendering ----

const money = (n: number | null) => (n === null ? "n/a" : usd(n));
const num = (n: number | null) => (n === null ? "n/a" : Number.isInteger(n) ? String(n) : n.toFixed(2));
const rolesCell = (r: Record<RunRole, number>) => `${r.builder} / ${r.planner} / ${r.reviewer}`;

const metricCells = (m: PeriodMetrics) => [
  String(m.totalRuns),
  rolesCell(m.runs),
  money(m.spendUsd),
  money(m.usdPerRun),
  num(m.redirectsPerPr),
  money(m.reviewUsdPerPr),
  num(m.mergedPrs),
  money(m.usdPerMergedPr),
];
const METRIC_HEADERS = ["Runs", "Build / plan / review", "Spend", "$/run", "Redirects/PR", "Review $/PR", "Merged PRs", "$/merged PR"];

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The issue body. Built only from the report's numbers, fixed text and slug-checked repo labels. */
export function renderMetricsMarkdown(report: MetricsReport): string {
  const { cycle, drift, findings, notes } = report;
  // Newest first, without the idle days; metrics/<day>.json has them all.
  const busy = [...report.days].reverse().filter((d) => d.metrics.totalRuns > 0 || d.metrics.spendUsd > 0 || (d.metrics.mergedPrs ?? 0) > 0);
  const out: string[] = [
    `Updated nightly by \`nightly.yml\` (ADR-0020). Totals run through ${report.day}, the last complete UTC day. Generated ${report.generatedAt}.`,
    "",
    "## Budget watcher",
    "",
    findings.length === 0 ? "All clear." : findings.map((f) => `- **${f.code}:** ${f.message}`).join("\n"),
    "",
    `## Cycle ${cycle.start} to ${cycle.end}`,
    "",
    `Day ${cycle.elapsedDays} of ${cycle.lengthDays}. Spend ${usd(cycle.spendUsd)} of the ${usd(cycle.capUsd)} cap. ${cycle.projectedUsd === null ? `Projected from day ${PROJECTION_MIN_DAYS}.` : `Projected ${usd(cycle.projectedUsd)} at the last ${cycle.projectionPaceDays} days' pace.`}`,
    "",
    table(["Repo", ...METRIC_HEADERS], [["all", ...metricCells(cycle.metrics)], ...report.byRepo.map((r) => [r.repo, ...metricCells(r.metrics)])]),
    "",
    `Spend comes from the ledger; run counts, redirects and review cost from \`run.json\`. \`${OTHER_REPO}\` is every repo not confirmed public.`,
  ];
  if (cycle.runRecordsExpiring) out.push("", `Run records last ${RUN_RECORD_RETENTION_DAYS} days, so run-derived numbers can miss this cycle's first days. Ledger spend is complete.`);
  if (notes.runsWithoutBaseline > 0) {
    out.push("", `${plural(notes.runsWithoutBaseline, "resumed run has", "resumed runs have")} no earlier turn on record, so ${notes.runsWithoutBaseline === 1 ? "its" : "their"} cost isn't in the run-record figures.`);
  }
  if (notes.reposWithoutMergeCount > 0) {
    out.push("", `Merged PRs couldn't be counted for ${plural(notes.reposWithoutMergeCount, "public repo")}; ${notes.reposWithoutMergeCount === 1 ? "its" : "their"} spend is left out of $/merged PR.`);
  }
  out.push(
    "",
    "## Check against the Console",
    "",
    `Cycle to date: **${usd(cycle.spendUsd)}**. Compare with the \`globalhost-runners\` workspace in the Anthropic Console (P1-13). The Console should read higher by what the ledger doesn't see: \`security-audit.yml\`, local \`globalhost run\` / \`assess\`, and any session that died mid-run, whose spend only its reservation hints at. The Console's workspace limit is the hard cap. Ledger costs are list cost.`,
    "",
    ...(cycle.released.count > 0
      ? [`Released without settling this cycle: **${plural(cycle.released.count, "reservation")}, ${usd(cycle.released.usd)}**. Those sessions died, so the Console can read higher by up to that (\`cleanup.yml\`).`, ""]
      : []),
    `Run records against the ledger, ${drift.from} to ${drift.to}: ${usd(drift.runRecordsUsd)} and ${usd(drift.ledgerUsd)}, a difference of ${usd(drift.diffUsd)} added up per repo (allowed ${usd(drift.allowedUsd)}).${drift.unknownBaseline ? " Not checked: a resumed run in this window has no earlier turn on record." : ""}`,
    "",
    "## By day",
    "",
    busy.length === 0 ? "Nothing yet this cycle." : table(["Day", ...METRIC_HEADERS], busy.map((d) => [d.day, ...metricCells(d.metrics)])),
    "",
  );
  return out.join("\n");
}
