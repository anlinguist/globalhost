// The per-PR review ledger and shadow index (ADR-0015 §12, §13), and the per-SHA review claim. Both live in the
// control bucket and are written only by trusted code (the dispatcher): the ledger holds the PR's review spend
// and open budget reservations, which the budget gate reads, and one summary entry per review run, which shadow
// mode (L2) and the merge policy (P2-01c) read. Entries summarise the archived ReviewRecord; findings and scan
// excerpts stay in the record.
import { z } from "zod";
import { MAX_REVIEW_USD, ReviewRecordFields, checkVerdictInvariants, type ReviewRecord } from "./review.js";
import { SCAN_HIT_CODES } from "./review-scan.js";

/** Runs kept per PR in the index. Older entries drop off; their cost moves to `truncatedSpendUsd`. */
export const MAX_LEDGER_RUNS = 200;
/** Open reservations per PR. Each holds a run's cap until settled, so this is far above any real number. */
export const MAX_LEDGER_RESERVATIONS = 50;

/** Run IDs go into object names (the per-attempt archive path), so they are a closed character set. */
export const REVIEW_RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;
const runId = z.string().regex(REVIEW_RUN_ID).refine((s) => !s.includes(".."));

const MICRO = 1e6;
const micros = (usd: number) => Math.round(usd * MICRO);

/** Adds dollar amounts without float noise building up (kept to a millionth of a dollar). */
export function addUsd(...amounts: number[]): number {
  return amounts.reduce((sum, a) => sum + micros(a), 0) / MICRO;
}

/** One review run as the shadow index records it. Same fields as the ReviewRecord minus the bulky ones. */
export const ShadowEntrySchema = ReviewRecordFields.pick({
  sha: true,
  patchId: true,
  baseSha: true,
  sessionId: true,
  agentVersion: true,
  model: true,
  ciRunId: true,
  status: true,
  verdicts: true,
  overall: true,
  escalations: true,
  taint: true,
  costUsd: true,
  prSpendUsd: true,
  reviewPath: true,
  postedReviewId: true,
  recordedAt: true,
})
  .extend({
    runId,
    /** Distinct scan hit codes only: excerpts quote builder-written text and stay in the archived record. */
    scanHits: z.array(z.enum(SCAN_HIT_CODES)).max(SCAN_HIT_CODES.length),
  })
  .superRefine((e, ctx) => {
    checkVerdictInvariants(e, ctx);
    if (new Set(e.scanHits).size !== e.scanHits.length) {
      ctx.addIssue({ code: "custom", path: ["scanHits"], message: "scan hit codes must be unique" });
    }
  });
export type ShadowEntry = z.infer<typeof ShadowEntrySchema>;

/**
 * A review run's budget hold, taken before the run starts (`limits.reviewPerRunUsd`). It counts against the
 * PR budget, and `day`'s daily budget, until the run's cost is recorded. A run that crashes never settles, so
 * its hold stays counted: the ledger fails toward overcounting, and only an owner clears it.
 */
export const ReviewReservationSchema = z.strictObject({
  runId,
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  reservedUsd: z.number().positive().max(MAX_REVIEW_USD),
  reservedAt: z.iso.datetime(),
  /** The UTC day whose daily spend record holds the matching reservation. */
  day: z.iso.date(),
});
export type ReviewReservation = z.infer<typeof ReviewReservationSchema>;

/** `gs://globalhost-control/reviews/<repo>/pr-<n>.json`. Updated by compare-and-swap only. */
export const ReviewLedgerSchema = z
  .strictObject({
    version: z.literal(1),
    /** Total settled review spend on this PR, every run included (also runs that dropped off `runs`). */
    reviewSpendUsd: z.number().min(0),
    /** Settled spend of runs that dropped off `runs`, so `reviewSpendUsd` still adds up. */
    truncatedSpendUsd: z.number().min(0),
    runs: z.array(ShadowEntrySchema).max(MAX_LEDGER_RUNS),
    reservations: z.array(ReviewReservationSchema).max(MAX_LEDGER_RESERVATIONS),
  })
  .superRefine((l, ctx) => {
    const runIds = l.runs.map((r) => r.runId);
    if (new Set(runIds).size !== runIds.length) {
      ctx.addIssue({ code: "custom", path: ["runs"], message: "run IDs must be unique" });
    }
    const held = l.reservations.map((r) => r.runId);
    if (new Set(held).size !== held.length || held.some((id) => runIds.includes(id))) {
      ctx.addIssue({ code: "custom", path: ["reservations"], message: "a run holds at most one reservation, and none once settled" });
    }
    // Each amount is rounded to a micro-dollar on its own, so allow one micro of drift per term.
    const sum = micros(l.truncatedSpendUsd) + l.runs.reduce((s, r) => s + micros(r.costUsd), 0);
    if (Math.abs(micros(l.reviewSpendUsd) - sum) > l.runs.length + 1) {
      ctx.addIssue({ code: "custom", path: ["reviewSpendUsd"], message: "must equal truncatedSpendUsd plus every run's cost" });
    }
  });
export type ReviewLedger = z.infer<typeof ReviewLedgerSchema>;

export const EMPTY_REVIEW_LEDGER: ReviewLedger = Object.freeze({
  version: 1,
  reviewSpendUsd: 0,
  truncatedSpendUsd: 0,
  runs: [],
  reservations: [],
}) as ReviewLedger;

/** Settled spend plus every open reservation: what the budget gate counts as committed. */
export function committedReviewUsd(ledger: ReviewLedger): number {
  return addUsd(ledger.reviewSpendUsd, ...ledger.reservations.map((r) => r.reservedUsd));
}

/** The shadow index entry for an archived review record. `prSpendUsd` is restamped when the ledger records it. */
export function shadowEntryFromRecord(record: ReviewRecord): ShadowEntry {
  return ShadowEntrySchema.parse({
    sha: record.sha,
    patchId: record.patchId,
    baseSha: record.baseSha,
    runId: record.runId,
    sessionId: record.sessionId,
    agentVersion: record.agentVersion,
    model: record.model,
    ciRunId: record.ciRunId,
    status: record.status,
    verdicts: record.verdicts,
    overall: record.overall,
    escalations: record.escalations,
    taint: record.taint,
    scanHits: SCAN_HIT_CODES.filter((c) => record.scanHits.some((h) => h.code === c)),
    costUsd: record.costUsd,
    prSpendUsd: record.prSpendUsd,
    reviewPath: record.reviewPath,
    postedReviewId: record.postedReviewId,
    recordedAt: record.recordedAt,
  });
}

/**
 * `gs://globalhost-control/reviews/<repo>/pr-<n>/<sha>.claim.json`: one live review attempt per head SHA. A
 * claim with no `recordPath` older than the staleness window belongs to a crashed run and can be taken over by
 * compare-and-swap; a completed one can be replaced only by an owner-requested re-review (`attempt` + 1). The
 * SHA is 40-hex only: a SHA-256 repository fails closed (known limit).
 */
export const ReviewClaimSchema = z.strictObject({
  version: z.literal(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 1 for the first review of this SHA, +1 per re-review or takeover. */
  attempt: z.number().int().min(1).max(1000),
  runId,
  claimedAt: z.iso.datetime(),
  /** The run whose claim this one replaced (a stale takeover or a re-review), if any. */
  previousRunId: runId.nullable(),
  /**
   * limits.perRunMinutes when the claim was taken: its staleness window is judged by this, so lowering the limit
   * mid-run can't make a live claim stale early. Absent on claims written before it existed (current config then).
   */
  perRunMinutes: z.number().int().min(5).max(180).optional(),
  completedAt: z.iso.datetime().nullable(),
  /** The archived review record of this attempt, in the runs bucket. Set when the review completes. */
  recordPath: z.string().min(1).max(500).nullable(),
});
export type ReviewClaim = z.infer<typeof ReviewClaimSchema>;

/**
 * The review budget gate (pure): a review may start only if the PR's committed spend (settled plus open
 * reservations) plus one run's cap fits under the PR budget (`limits.reviewPerRunUsd`, `limits.reviewPerPrUsd`).
 * Unknown or corrupt amounts (NaN, Infinity, negative) fail closed.
 */
export function canStartReview({ spent, reserved = 0, perRun, perPr }: { spent: number; reserved?: number; perRun: number; perPr: number }): boolean {
  if (![spent, reserved, perRun, perPr].every(Number.isFinite) || spent < 0 || reserved < 0 || perRun <= 0 || perPr <= 0) return false;
  return micros(spent) + micros(reserved) + micros(perRun) <= micros(perPr);
}
