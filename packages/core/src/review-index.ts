// The per-PR review ledger and shadow index (ADR-0015 §12, §13), and the per-SHA review claim. Both live in the
// control bucket and are written only by trusted code (the dispatcher): the ledger holds the PR's review spend,
// which the budget gate reads, and one summary entry per review run, which shadow mode (L2) and the merge policy
// (P2-01c) read. Entries summarise the archived ReviewRecord; findings and scan excerpts stay in the record.
import { z } from "zod";
import { ReviewRecordFields, checkVerdictInvariants, type ReviewRecord } from "./review.js";
import { SCAN_HIT_CODES } from "./review-scan.js";

/** Runs kept per PR in the index. Older entries drop off; the spend total still counts them. */
export const MAX_LEDGER_RUNS = 200;

/** One review run as the shadow index records it. Same fields as the ReviewRecord minus the bulky ones. */
export const ShadowEntrySchema = ReviewRecordFields.pick({
  sha: true,
  patchId: true,
  baseSha: true,
  runId: true,
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

/** `gs://globalhost-control/reviews/<repo>/pr-<n>.json`. Updated by compare-and-swap only. */
export const ReviewLedgerSchema = z
  .strictObject({
    version: z.literal(1),
    /** Total review spend on this PR, every run included (also runs that dropped off `runs`). */
    reviewSpendUsd: z.number().min(0),
    runs: z.array(ShadowEntrySchema).max(MAX_LEDGER_RUNS),
  })
  .superRefine((l, ctx) => {
    if (new Set(l.runs.map((r) => r.runId)).size !== l.runs.length) {
      ctx.addIssue({ code: "custom", path: ["runs"], message: "run IDs must be unique" });
    }
  });
export type ReviewLedger = z.infer<typeof ReviewLedgerSchema>;

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
 * `gs://globalhost-control/reviews/<repo>/pr-<n>/<sha>.claim.json`: created once per head SHA so only one review
 * runs per SHA. A claim with no `recordPath` older than the caller's staleness window belongs to a crashed run
 * and can be taken over by compare-and-swap.
 */
export const ReviewClaimSchema = z.strictObject({
  version: z.literal(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  runId: z.string().min(1).max(200),
  claimedAt: z.iso.datetime(),
  /** The run whose stale claim this one took over, if any. */
  previousRunId: z.string().min(1).max(200).nullable(),
  completedAt: z.iso.datetime().nullable(),
  /** The archived review record, in the runs bucket. Set when the review completes. */
  recordPath: z.string().min(1).max(500).nullable(),
});
export type ReviewClaim = z.infer<typeof ReviewClaimSchema>;

const MICRO = 1e6;
const micros = (usd: number) => Math.round(usd * MICRO);

/** Adds two dollar amounts without float noise building up (kept to a millionth of a dollar). */
export function addUsd(a: number, b: number): number {
  return (micros(a) + micros(b)) / MICRO;
}

/**
 * The review budget gate (pure): a review may start only if the PR's spend so far plus one run's cap fits under
 * the PR budget (`limits.reviewPerRunUsd`, `limits.reviewPerPrUsd`). Unknown or corrupt spend (NaN, Infinity,
 * negative) fails closed.
 */
export function canStartReview({ spent, perRun, perPr }: { spent: number; perRun: number; perPr: number }): boolean {
  if (![spent, perRun, perPr].every(Number.isFinite) || spent < 0 || perRun <= 0 || perPr <= 0) return false;
  return micros(spent) + micros(perRun) <= micros(perPr);
}
