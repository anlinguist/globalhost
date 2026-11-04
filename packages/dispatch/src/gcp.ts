// GCP access for the dispatcher, as sa:globalhost-gh-dispatch through WIF (P1-04): the control bucket
// (kill switch, daily spend, builder slots, review claims, the per-PR review ledger), the runs bucket (archived
// outputs) and the App key secret.
// All control writes are compare-and-swap on the object generation, so concurrent runs can't race.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addUsd,
  canStartReview,
  committedReviewUsd,
  EMPTY_REVIEW_LEDGER,
  MAX_LEDGER_RUNS,
  REVIEW_RUN_ID,
  ReviewClaimSchema,
  ReviewLedgerSchema,
  ReviewReservationSchema,
  ShadowEntrySchema,
  type ReviewClaim,
  type ReviewLedger,
  type ReviewReservation,
  type ShadowEntry,
} from "@globalhost/core";
import { z } from "zod";

const exec = promisify(execFile);

const ListPageSchema = z.object({
  items: z.array(z.object({ name: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

export const CONTROL_BUCKET = "globalhost-control";
export const RUNS_BUCKET = "globalhost-runs";
export const FACTORY_PROJECT = "globalhost-factory";

export type AccessToken = () => Promise<string>;

/** After google-github-actions/auth, gcloud holds the WIF credential; tokens are minted per call. */
export const gcloudAccessToken: AccessToken = async () => (await exec("gcloud", ["auth", "print-access-token"])).stdout.trim();

interface Obj {
  body: string;
  generation: string;
}

export class ObjectStore {
  constructor(
    private readonly token: AccessToken,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${await this.token()}`, ...extra };
  }

  async read(bucket: string, name: string): Promise<Obj | null> {
    const base = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
    const meta = await this.fetchImpl(base, { headers: await this.headers() });
    if (meta.status === 404) return null;
    if (!meta.ok) throw new Error(`GCS read gs://${bucket}/${name}: HTTP ${meta.status}`);
    const { generation } = (await meta.json()) as { generation: string };
    const data = await this.fetchImpl(`${base}?alt=media&generation=${generation}`, { headers: await this.headers() });
    if (data.status === 404) return null; // replaced between the two calls; callers retry
    if (!data.ok) throw new Error(`GCS read gs://${bucket}/${name}: HTTP ${data.status}`);
    return { body: await data.text(), generation };
  }

  /** ifGenerationMatch "0" = create only; returns "conflict" when the precondition fails. */
  async write(bucket: string, name: string, body: string | Uint8Array, ifGenerationMatch?: string, contentType = "application/json"): Promise<"ok" | "conflict"> {
    const params = new URLSearchParams({ uploadType: "media", name });
    if (ifGenerationMatch !== undefined) params.set("ifGenerationMatch", ifGenerationMatch);
    const resp = await this.fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?${params}`, {
      method: "POST",
      headers: await this.headers({ "content-type": contentType }),
      body,
    });
    if (resp.status === 412) return "conflict";
    if (!resp.ok) throw new Error(`GCS write gs://${bucket}/${name}: HTTP ${resp.status}`);
    return "ok";
  }

  /** Every object name under a prefix, following pagination. A bucket that can't be listed throws. */
  async list(bucket: string, prefix: string): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ prefix, fields: "items(name),nextPageToken" });
      if (pageToken) params.set("pageToken", pageToken);
      const resp = await this.fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params}`, { headers: await this.headers() });
      if (!resp.ok) throw new Error(`GCS list gs://${bucket}: HTTP ${resp.status}`);
      const page = ListPageSchema.parse(await resp.json());
      for (const item of page.items) names.push(item.name);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return names;
  }

  async remove(bucket: string, name: string, ifGenerationMatch: string): Promise<"ok" | "conflict"> {
    const resp = await this.fetchImpl(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?ifGenerationMatch=${ifGenerationMatch}`,
      { method: "DELETE", headers: await this.headers() },
    );
    if (resp.status === 412 || resp.status === 404) return "conflict";
    if (!resp.ok) throw new Error(`GCS delete gs://${bucket}/${name}: HTTP ${resp.status}`);
    return "ok";
  }
}

const repoKey = (repo: string) => repo.replace("/", "__");
const MAX_CAS_ATTEMPTS = 8;

// ---- Review control state (P2-01) ----
//
// Contract for the review step (review.ts), so a review can't double-spend, double-post or lose its cost:
//   1. reviewClaim for the head SHA (per attempt; `rereview` only for an owner's factory:review on a SHA whose
//      last review completed). Not claimed → don't run and don't reserve: a duplicate trigger costs nothing.
//   2. reserveReview before starting: holds limits.reviewPerRunUsd against the PR budget and the repo's daily
//      budget in one step each. Refused → don't run; record a budget-exhausted review (it escalates).
//   3. Archive the run under reviewArchivePrefix(head, runId) in the runs bucket, never a shared per-SHA path.
//   4. recordReviewRun ALWAYS once claimed, whatever happened, with the actual cost (or the per-run cap when a
//      session may exist and its cost is unknown): it settles the reservation.
//   5. completeReviewClaim (only after archiving); post the GitHub review only if it returned true.
// A crashed run never settles, so its reservation stays counted at the full per-run cap (fails toward
// overcounting); releaseStaleReservation is for the owner or the P1-13 cleanup job only, never automatic.

// Owner: 1–39 alphanumerics or hyphens, not starting with a hyphen. Name: 1–100 of [A-Za-z0-9._-]. This is a
// superset of what GitHub allows (it also forbids trailing or doubled hyphens); `.` and `..` names are refused below.
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** Whether a string is a well-formed `owner/name`, safe to put in an object name or a report. */
export const isRepoSlug = (repo: string): boolean => REPO_SLUG.test(repo) && !repo.endsWith("/.") && !repo.includes("..");

// 40-hex only: a SHA-256 repository fails closed here (known limit; ReviewRecord itself accepts 64-hex).
const HEAD_SHA = /^[0-9a-f]{40}$/;

/** A PR, as review objects key it. */
export interface ReviewPr {
  /** `owner/name`. Lowercased in object names: GitHub names are case-insensitive, so one PR has one budget. */
  repo: string;
  pr: number;
}
export interface ReviewHead extends ReviewPr {
  /** The PR head commit, 40 lowercase hex. */
  sha: string;
}

/** The validated, lowercased repo and PR number, checked before either goes into an object name. */
function reviewKey(repo: unknown, pr: unknown): { repo: string; pr: string } {
  if (typeof repo !== "string" || !isRepoSlug(repo)) {
    throw new Error("review: repo must be an owner/name slug");
  }
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("review: pr must be a positive integer");
  return { repo: repo.toLowerCase(), pr: `pr-${pr}` };
}

function checkSha(sha: unknown): string {
  if (typeof sha !== "string" || !HEAD_SHA.test(sha)) throw new Error("review: sha must be 40 lowercase hex characters");
  return sha;
}

function checkRunId(runId: unknown): string {
  if (typeof runId !== "string" || !REVIEW_RUN_ID.test(runId) || runId.includes("..")) {
    throw new Error("review: runId must be 1-100 of [A-Za-z0-9_.-]");
  }
  return runId;
}

/** `reviews/<repo>/pr-<n>.json` in the control bucket: the PR's review ledger and shadow index. */
export function reviewLedgerObject({ repo, pr }: ReviewPr): string {
  const k = reviewKey(repo, pr);
  return `reviews/${k.repo}/${k.pr}.json`;
}

/** `reviews/<repo>/pr-<n>/<sha>.claim.json` in the control bucket: one live review attempt per head SHA. */
export function reviewClaimObject({ repo, pr, sha }: ReviewHead): string {
  const k = reviewKey(repo, pr);
  return `reviews/${k.repo}/${k.pr}/${checkSha(sha)}.claim.json`;
}

/**
 * `<repo>/reviews/pr-<n>/<sha>/<runId>/` in the runs bucket: where one review attempt archives `review.json`,
 * `run.json`, `output.raw.json` and `inputs.json` (create-only). Per attempt, so a re-review never collides.
 */
export function reviewArchivePrefix({ repo, pr, sha }: ReviewHead, runId: string): string {
  const k = reviewKey(repo, pr);
  return `${k.repo}/reviews/${k.pr}/${checkSha(sha)}/${checkRunId(runId)}/`;
}

/** The archived review record of one attempt, in the runs bucket. */
export function reviewRecordPath(head: ReviewHead, runId: string): string {
  return `${reviewArchivePrefix(head, runId)}review.json`;
}

/**
 * How old an uncompleted claim must be before another run may take it over: the run's own timeout plus margin
 * for archiving. Anything shorter could hand a live review's SHA to a second run.
 */
export function minReviewStaleMinutes(perRunMinutes: number): number {
  if (!Number.isInteger(perRunMinutes) || perRunMinutes < 5 || perRunMinutes > 180) {
    throw new Error("review: perRunMinutes must be an integer 5-180 (limits.perRunMinutes)");
  }
  return perRunMinutes + 30;
}

export type ReviewClaimResult =
  | { claimed: true; claim: ReviewClaim }
  | { claimed: false; existing: ReviewClaim; reason: "in-flight" | "completed" | "lost-race" }
  | { claimed: false; existing: null; reason: "corrupt" | "lost-race" };

export type ReserveReviewResult =
  | { reserved: true; reservation: ReviewReservation }
  | { reserved: false; reason: "pr-budget" | "daily-budget" | "already-recorded"; committedUsd: number };

function parseLedger(name: string, body: string): ReviewLedger {
  try {
    return ReviewLedgerSchema.parse(JSON.parse(body));
  } catch {
    throw new Error(`gs://${CONTROL_BUCKET}/${name} is not a valid review ledger; fix it by hand`);
  }
}

/** The daily spend record (`spend/<day>/<repo>.json`): settled `usd`, recent `runs`, open review `reservations`. */
interface DailySpend {
  usd: number;
  runs: { runId: string; usd: number; kind?: string }[];
  reservations: { runId: string; usd: number; at: string }[];
}

/** Parses a daily spend record; null when it is corrupt (callers fail closed). */
function parseDaily(raw: Record<string, unknown>): DailySpend | null {
  const usd = raw.usd ?? 0;
  const runs = raw.runs ?? [];
  const reservations = raw.reservations ?? [];
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || !Array.isArray(runs) || !Array.isArray(reservations)) return null;
  for (const r of reservations as unknown[]) {
    const ok = typeof r === "object" && r !== null && typeof (r as { runId?: unknown }).runId === "string" &&
      typeof (r as { usd?: unknown }).usd === "number" && Number.isFinite((r as { usd: number }).usd) && (r as { usd: number }).usd >= 0;
    if (!ok) return null;
  }
  return { usd, runs: runs as DailySpend["runs"], reservations: reservations as DailySpend["reservations"] };
}

const dailyCommitted = (d: DailySpend) => addUsd(d.usd, ...d.reservations.map((r) => r.usd));

export class ControlPlane {
  constructor(
    private readonly store: ObjectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The kill switch. Unreadable or corrupt state fails closed. */
  async paused(): Promise<boolean> {
    const obj = await this.store.read(CONTROL_BUCKET, "state.json");
    if (!obj) return false;
    try {
      const state = JSON.parse(obj.body) as { paused?: unknown };
      // Anything but an explicit false (or no flag) counts as paused.
      return state.paused !== undefined && state.paused !== false;
    } catch {
      return true;
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.update("state.json", (cur) => ({ ...cur, paused, updatedAt: this.now().toISOString() }));
  }

  private spendObjectFor(day: string, repo: string) {
    return `spend/${day}/${repoKey(repo)}.json`;
  }

  private spendObject(repo: string) {
    return this.spendObjectFor(this.now().toISOString().slice(0, 10), repo);
  }

  /** Today's settled spend plus open review reservations (builder and review runs share dailyUsd). */
  async spentTodayUsd(repo: string): Promise<number> {
    const obj = await this.store.read(CONTROL_BUCKET, this.spendObject(repo));
    if (!obj) return 0;
    const raw = JSON.parse(obj.body) as unknown;
    const daily = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? parseDaily(raw as Record<string, unknown>) : null;
    return daily ? dailyCommitted(daily) : Number.POSITIVE_INFINITY; // corrupt → over budget
  }

  /** Adds a run's cost to today's total. A resumed session's cost is cumulative, so pass the delta. */
  async recordSpend(repo: string, runId: string, usd: number): Promise<void> {
    await this.update(this.spendObject(repo), (cur) => ({
      ...cur, // keeps open review reservations
      usd: Math.round(((typeof cur.usd === "number" ? cur.usd : 0) + usd) * 100) / 100,
      runs: [...(Array.isArray(cur.runs) ? cur.runs : []), { runId, usd }].slice(-200),
    }));
  }

  /**
   * Takes one of `slots` builder slots for the repo (limits.maxConcurrentBuilders). A slot older than
   * `staleMinutes` is assumed abandoned (a crashed job) and taken over. Returns the slot or null if busy.
   */
  async acquireSlot(repo: string, runId: string, slots: number, staleMinutes: number): Promise<string | null> {
    for (let i = 0; i < slots; i++) {
      const name = `locks/${repoKey(repo)}/builder-${i}.json`;
      const body = JSON.stringify({ runId, takenAt: this.now().toISOString() });
      if ((await this.store.write(CONTROL_BUCKET, name, body, "0")) === "ok") return name;
      const held = await this.store.read(CONTROL_BUCKET, name);
      if (!held) continue;
      const takenAt = Date.parse((JSON.parse(held.body) as { takenAt?: string }).takenAt ?? "");
      if (!(this.now().getTime() - takenAt > staleMinutes * 60_000)) continue;
      if ((await this.store.write(CONTROL_BUCKET, name, body, held.generation)) === "ok") return name;
    }
    return null;
  }

  async releaseSlot(slot: string, runId: string): Promise<void> {
    const held = await this.store.read(CONTROL_BUCKET, slot);
    if (!held || (JSON.parse(held.body) as { runId?: string }).runId !== runId) return;
    await this.store.remove(CONTROL_BUCKET, slot, held.generation);
  }

  /**
   * Claims a review attempt for one head SHA (create-only), so at most one review of a SHA is in flight. If
   * another run holds it:
   * - in flight: refused, unless older than minReviewStaleMinutes(perRunMinutes) (a crashed run), in which case
   *   it is taken over by compare-and-swap;
   * - completed: refused, unless `rereview` (an owner's `factory:review` on this SHA), which starts the next
   *   attempt. A re-review never replaces an in-flight claim;
   * - corrupt: refused and never taken over (`reason: "corrupt"`); a human clears it.
   * The same runId asking again while it holds the claim gets it back (a retried step).
   */
  async reviewClaim(
    head: ReviewHead,
    runId: string,
    { perRunMinutes, rereview = false }: { perRunMinutes: number; rereview?: boolean },
  ): Promise<ReviewClaimResult> {
    const name = reviewClaimObject(head);
    checkRunId(runId);
    minReviewStaleMinutes(perRunMinutes); // validates it before anything is written
    const fresh = (attempt: number, previousRunId: string | null): ReviewClaim =>
      ReviewClaimSchema.parse({
        version: 1,
        sha: head.sha,
        attempt,
        runId,
        claimedAt: this.now().toISOString(),
        previousRunId,
        perRunMinutes,
        completedAt: null,
        recordPath: null,
      });
    const first = fresh(1, null);
    if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(first), "0")) === "ok") return { claimed: true, claim: first };

    const held = await this.readClaim(name);
    if (held === "missing") return { claimed: false, existing: null, reason: "lost-race" }; // deleted under us
    if (held === "corrupt") return { claimed: false, existing: null, reason: "corrupt" };
    const { claim: existing, generation } = held;
    if (existing.recordPath === null) {
      if (existing.runId === runId) return { claimed: true, claim: existing };
      // The holder's own window (stored when it claimed), not today's config: a lowered limit mustn't cut it short.
      const staleMs = minReviewStaleMinutes(existing.perRunMinutes ?? perRunMinutes) * 60_000;
      if (!(this.now().getTime() - Date.parse(existing.claimedAt) > staleMs)) return { claimed: false, existing, reason: "in-flight" };
    } else if (!rereview) {
      return { claimed: false, existing, reason: "completed" };
    }
    const next = fresh(existing.attempt + 1, existing.runId);
    if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(next), generation)) === "ok") return { claimed: true, claim: next };
    const now = await this.readClaim(name);
    return typeof now === "string" ? { claimed: false, existing: null, reason: "lost-race" } : { claimed: false, existing: now.claim, reason: "lost-race" };
  }

  /**
   * Marks the holder's claim completed, pointing at its archived record (reviewRecordPath). Returns false if
   * `runId` doesn't hold the claim (taken over, or replaced by a re-review): then the caller must not post.
   * Idempotent for the holder.
   */
  async completeReviewClaim(head: ReviewHead, runId: string): Promise<boolean> {
    const name = reviewClaimObject(head);
    const recordPath = reviewRecordPath(head, runId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const held = await this.readClaim(name);
      if (typeof held === "string" || held.claim.runId !== runId) return false;
      if (held.claim.recordPath !== null) return held.claim.recordPath === recordPath;
      const done = ReviewClaimSchema.parse({ ...held.claim, completedAt: this.now().toISOString(), recordPath });
      if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(done), held.generation)) === "ok") return true;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }

  private async readClaim(name: string): Promise<{ claim: ReviewClaim; generation: string } | "missing" | "corrupt"> {
    const obj = await this.store.read(CONTROL_BUCKET, name);
    if (!obj) return "missing";
    try {
      return { claim: ReviewClaimSchema.parse(JSON.parse(obj.body)), generation: obj.generation };
    } catch {
      return "corrupt";
    }
  }

  /** The PR's settled review spend. No ledger is 0; a corrupt one counts as over budget. */
  async prReviewSpend(pr: ReviewPr): Promise<number> {
    const obj = await this.store.read(CONTROL_BUCKET, reviewLedgerObject(pr));
    if (!obj) return 0;
    try {
      return ReviewLedgerSchema.parse(JSON.parse(obj.body)).reviewSpendUsd;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** The PR's ledger and shadow index, or null before its first reservation. Throws if it is corrupt. */
  async reviewLedger(pr: ReviewPr): Promise<ReviewLedger | null> {
    const name = reviewLedgerObject(pr);
    const obj = await this.store.read(CONTROL_BUCKET, name);
    return obj ? parseLedger(name, obj.body) : null;
  }

  /**
   * Reserves one review run's cap (`perRun` = limits.reviewPerRunUsd) before the run starts, by
   * compare-and-swap: first on the PR ledger (settled + open reservations + perRun ≤ perPr), then on today's
   * daily spend record (settled + open reservations + perRun ≤ dailyUsd; builder and review runs share it). If
   * the daily check fails the PR reservation is released again. Idempotent per runId.
   */
  async reserveReview(
    head: ReviewHead,
    runId: string,
    { perRun, perPr, dailyUsd }: { perRun: number; perPr: number; dailyUsd: number },
  ): Promise<ReserveReviewResult> {
    const name = reviewLedgerObject(head);
    checkSha(head.sha);
    checkRunId(runId);
    if (![perRun, perPr, dailyUsd].every((v) => Number.isFinite(v) && v > 0)) throw new Error("review: budgets must be positive");

    type Step = { ok: true; reservation: ReviewReservation } | { ok: false; reason: "pr-budget" | "already-recorded"; cur: ReviewLedger };
    const pr = await this.casLedger<Step>(name, (cur) => {
      if (cur.runs.some((r) => r.runId === runId)) return { result: { ok: false, reason: "already-recorded", cur } };
      const held = cur.reservations.find((r) => r.runId === runId);
      if (held) return { result: { ok: true, reservation: held } };
      const reserved = addUsd(...cur.reservations.map((r) => r.reservedUsd));
      if (!canStartReview({ spent: cur.reviewSpendUsd, reserved, perRun, perPr })) {
        return { result: { ok: false, reason: "pr-budget", cur } };
      }
      const now = this.now().toISOString();
      const reservation = ReviewReservationSchema.parse({ runId, sha: head.sha, reservedUsd: perRun, reservedAt: now, day: now.slice(0, 10) });
      return { next: { ...cur, reservations: [...cur.reservations, reservation] }, result: { ok: true, reservation } };
    });
    if (!pr.ok) return { reserved: false, reason: pr.reason, committedUsd: committedReviewUsd(pr.cur) };
    const { reservation } = pr;

    const daily = await this.casDaily(this.spendObjectFor(reservation.day, head.repo), (cur) => {
      if (cur === null) return { result: { ok: false, committed: Number.POSITIVE_INFINITY } }; // corrupt → over budget
      if (cur.reservations.some((r) => r.runId === runId) || cur.runs.some((r) => r.runId === runId)) return { result: { ok: true, committed: 0 } };
      const committed = dailyCommitted(cur);
      if (!canStartReview({ spent: committed, perRun, perPr: dailyUsd })) return { result: { ok: false, committed } };
      const entry = { runId, usd: perRun, at: reservation.reservedAt };
      return { next: { ...cur, reservations: [...cur.reservations, entry] }, result: { ok: true, committed } };
    });
    if (daily.ok) return { reserved: true, reservation };
    await this.dropLedgerReservation(name, runId);
    return { reserved: false, reason: "daily-budget", committedUsd: daily.committed };
  }

  /**
   * Records a finished (or refused, or failed) review run: settles its reservation and adds the actual cost,
   * on the daily spend record of the reservation's day first, then on the PR ledger, where it appends the
   * shadow entry. Always call it, even when the run didn't start (cost 0). Idempotent per runId: recording a
   * run again changes nothing and returns the stored entry. A cost above the reservation is recorded as is.
   * `prSpendUsd` is restamped with the ledger's new total.
   */
  async recordReviewRun(pr: ReviewPr, entry: ShadowEntry): Promise<ShadowEntry> {
    const name = reviewLedgerObject(pr);
    const valid = ShadowEntrySchema.parse(entry);
    const before = await this.reviewLedger(pr);
    const seen = before?.runs.find((r) => r.runId === valid.runId);
    if (seen) return seen;
    const day = before?.reservations.find((r) => r.runId === valid.runId)?.day ?? this.now().toISOString().slice(0, 10);

    const dailyName = this.spendObjectFor(day, pr.repo);
    await this.casDaily(dailyName, (cur) => {
      if (cur === null) throw new Error(`gs://${CONTROL_BUCKET}/${dailyName} is not a valid spend record; fix it by hand`);
      if (cur.runs.some((r) => r.runId === valid.runId)) return { result: undefined };
      const next: DailySpend = {
        usd: addUsd(cur.usd, valid.costUsd),
        runs: [...cur.runs, { runId: valid.runId, usd: valid.costUsd, kind: "review" }].slice(-200),
        reservations: cur.reservations.filter((r) => r.runId !== valid.runId),
      };
      return { next, result: undefined };
    });

    return this.casLedger(name, (cur) => {
      const again = cur.runs.find((r) => r.runId === valid.runId);
      if (again) return { result: again };
      const reviewSpendUsd = addUsd(cur.reviewSpendUsd, valid.costUsd);
      const stored: ShadowEntry = { ...valid, prSpendUsd: reviewSpendUsd };
      const runs = [...cur.runs, stored];
      const dropped = runs.splice(0, Math.max(0, runs.length - MAX_LEDGER_RUNS));
      const next: ReviewLedger = {
        version: 1,
        reviewSpendUsd,
        truncatedSpendUsd: addUsd(cur.truncatedSpendUsd, ...dropped.map((r) => r.costUsd)),
        runs,
        reservations: cur.reservations.filter((r) => r.runId !== valid.runId),
      };
      return { next, result: stored };
    });
  }

  /**
   * Drops a reservation whose run will never settle (it crashed), from the PR ledger and its day's spend record,
   * without adding any cost. For the owner or the P1-13 cleanup job only: nothing calls it automatically, so an
   * unsettled run stays counted. Returns false if there was no such reservation.
   */
  async releaseStaleReservation(pr: ReviewPr, runId: string): Promise<boolean> {
    checkRunId(runId);
    const name = reviewLedgerObject(pr);
    const held = (await this.reviewLedger(pr))?.reservations.find((r) => r.runId === runId);
    if (!held) return false;
    await this.casDaily(this.spendObjectFor(held.day, pr.repo), (cur) =>
      cur === null ? { result: undefined } : { next: { ...cur, reservations: cur.reservations.filter((r) => r.runId !== runId) }, result: undefined },
    );
    return this.dropLedgerReservation(name, runId);
  }

  private dropLedgerReservation(name: string, runId: string): Promise<boolean> {
    return this.casLedger(name, (cur) =>
      cur.reservations.some((r) => r.runId === runId)
        ? { next: { ...cur, reservations: cur.reservations.filter((r) => r.runId !== runId) }, result: true }
        : { result: false },
    );
  }

  /** Compare-and-swap on a review ledger. `change` returns the result, and `next` when there is something to write. */
  private async casLedger<T>(name: string, change: (cur: ReviewLedger) => { next?: ReviewLedger; result: T }): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const obj = await this.store.read(CONTROL_BUCKET, name);
      const cur = obj ? parseLedger(name, obj.body) : EMPTY_REVIEW_LEDGER;
      const { next, result } = change(cur);
      if (next === undefined) return result;
      const body = JSON.stringify(ReviewLedgerSchema.parse(next));
      if ((await this.store.write(CONTROL_BUCKET, name, body, obj?.generation ?? "0")) === "ok") return result;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }

  /** Compare-and-swap on a daily spend record; `cur` is null when the record is corrupt. Keeps unknown fields. */
  private async casDaily<T>(name: string, change: (cur: DailySpend | null) => { next?: DailySpend; result: T }): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const obj = await this.store.read(CONTROL_BUCKET, name);
      let raw: Record<string, unknown> = {};
      let cur: DailySpend | null;
      try {
        raw = obj ? (JSON.parse(obj.body) as Record<string, unknown>) : {};
        cur = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? parseDaily(raw) : null;
      } catch {
        cur = null;
      }
      const { next, result } = change(cur);
      if (next === undefined) return result;
      if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify({ ...raw, ...next }), obj?.generation ?? "0")) === "ok") return result;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }

  private async update(name: string, change: (cur: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const obj = await this.store.read(CONTROL_BUCKET, name);
      let cur: Record<string, unknown> = {};
      if (obj) {
        try {
          cur = JSON.parse(obj.body) as Record<string, unknown>;
        } catch {
          throw new Error(`gs://${CONTROL_BUCKET}/${name} is not JSON; fix it by hand`);
        }
      }
      const result = await this.store.write(CONTROL_BUCKET, name, JSON.stringify(change(cur)), obj?.generation ?? "0");
      if (result === "ok") return;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }
}

/** Reads one secret version's payload into memory (Secret Manager REST). */
export async function accessSecret(token: AccessToken, name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const resp = await fetchImpl(
    `https://secretmanager.googleapis.com/v1/projects/${FACTORY_PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { authorization: `Bearer ${await token()}` } },
  );
  if (!resp.ok) throw new Error(`Secret Manager ${name}: HTTP ${resp.status}`);
  const body = (await resp.json()) as { payload?: { data?: string } };
  if (!body.payload?.data) throw new Error(`Secret Manager ${name}: empty payload`);
  return Buffer.from(body.payload.data, "base64").toString("utf8");
}
