// The reviewer's structured output, the harness-stamped review record, and the pure function that turns them
// into an overall verdict (ADR-0015 §2, §3, §8). The reviewer's output is untrusted: it is parsed strictly and
// rejected (never clipped or repaired) when it doesn't fit, and an invalid output escalates. The record is
// written by trusted code: the SHA is the one the harness checked out, never the reviewer's claim.
import { z } from "zod";
import { MAX_SCAN_HITS, ScanHitSchema, type ScanHit } from "./review-scan.js";

export const VERDICTS = ["pass", "changes", "escalate"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VerdictSchema = z.enum(VERDICTS);

/** The three things a review judges (ADR-0015 §2). */
export const VERDICT_AREAS = ["function", "security", "performance"] as const;
export type VerdictArea = (typeof VERDICT_AREAS)[number];

/** Finding areas: the verdict areas plus `meta`, for findings about the review itself. */
export const FINDING_AREAS = [...VERDICT_AREAS, "meta"] as const;
export type Area = (typeof FINDING_AREAS)[number];
export const AreaSchema = z.enum(FINDING_AREAS);

/** The closed category list each area allows. Escalation triggers key on these (ADR-0015 §3, §8). */
export const FINDING_CATEGORIES = {
  function: [
    "spec-mismatch",
    "missing-acceptance-test",
    "test-passes-on-base",
    "weak-test",
    "logic-bug",
    "regression",
    "error-handling",
    "ui-visual",
  ],
  security: ["auth", "iam", "secrets", "supply-chain", "injection", "data-exposure", "security-other"],
  performance: ["perf-regression", "query-cost", "bundle-size", "cloud-cost", "unbounded-resource"],
  meta: ["reviewer-manipulation", "unreviewable"],
} as const satisfies Record<Area, readonly string[]>;
export type FindingCategory = (typeof FINDING_CATEGORIES)[Area][number];
const ALL_CATEGORIES = Object.values(FINDING_CATEGORIES).flat() as [FindingCategory, ...FindingCategory[]];

/** Security categories that escalate at any severity (ADR-0015 §8). */
export const ESCALATING_SECURITY_CATEGORIES = ["auth", "iam", "secrets", "supply-chain"] as const satisfies readonly (typeof FINDING_CATEGORIES.security)[number][];

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const MAX_FINDINGS = 50;
export const MAX_TITLE = 200;
export const MAX_DETAIL = 2000;
export const MAX_SUMMARY = 2000;

const FINDING_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const FindingSchema = z
  .strictObject({
    area: AreaSchema,
    category: z.enum(ALL_CATEGORIES),
    /** A short stable identifier for the finding, e.g. `missing-null-check`. */
    code: z.string().regex(FINDING_CODE),
    severity: z.enum(SEVERITIES),
    file: z.string().min(1).max(500).nullable(),
    line: z.number().int().min(1).max(10_000_000).nullable(),
    title: z.string().min(1).max(MAX_TITLE),
    detail: z.string().max(MAX_DETAIL),
  })
  .superRefine((f, ctx) => {
    if (!(FINDING_CATEGORIES[f.area] as readonly string[]).includes(f.category)) {
      ctx.addIssue({
        code: "custom",
        path: ["category"],
        message: `category ${f.category} is not in area ${f.area}`,
      });
    }
  });
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictsSchema = z.strictObject({
  function: VerdictSchema,
  security: VerdictSchema,
  performance: VerdictSchema,
});
export type Verdicts = z.infer<typeof VerdictsSchema>;

/**
 * What the reviewer session must return. Strict: unknown keys are rejected, so a reviewer can't smuggle in a
 * `sha`, `confidence` or anything else the merge decision might be tempted to read.
 */
export const ReviewOutputSchema = z.strictObject({
  verdicts: VerdictsSchema,
  findings: z.array(FindingSchema).max(MAX_FINDINGS),
  summary: z.string().max(MAX_SUMMARY),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export type ParseReviewOutputResult =
  | { ok: true; output: ReviewOutput }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validate untrusted reviewer output. Never clips or repairs: anything that doesn't fit is rejected. */
export function parseReviewOutput(raw: unknown): ParseReviewOutputResult {
  const r = ReviewOutputSchema.safeParse(raw);
  if (r.success) return { ok: true, output: r.data };
  // Paths and zod messages only; never echo the offending values (they're reviewer-written).
  return {
    ok: false,
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  };
}

/** How the review run ended, as the harness saw it. */
export const REVIEW_STATUSES = ["completed", "invalid_output", "missing_output", "timeout", "budget_exhausted", "failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Why a review escalates. Closed: the merge policy and the posted reason text key on these. */
export const ESCALATION_REASONS = [
  "invalid-output",
  "missing-output",
  "timeout",
  "run-failed",
  "budget-exhausted",
  "scan-hit",
  "reviewer-escalated",
  "security-category",
  "reviewer-manipulation",
  "unreviewable",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

const STATUS_REASON: Record<Exclude<ReviewStatus, "completed">, EscalationReason> = {
  invalid_output: "invalid-output",
  missing_output: "missing-output",
  timeout: "timeout",
  budget_exhausted: "budget-exhausted",
  failed: "run-failed",
};

const RANK: Record<Verdict, number> = { pass: 0, changes: 1, escalate: 2 };
const atLeast = (v: Verdict, floor: Verdict): Verdict => (RANK[v] >= RANK[floor] ? v : floor);

export interface OverallVerdictContext {
  /** Hits from scanDiff over the reviewed diff. Any hit escalates. */
  scanHits: readonly ScanHit[];
  /** The PR's review budget ran out (before or during this review). */
  budgetExhausted: boolean;
  status: ReviewStatus;
}

export interface OverallVerdictResult {
  overall: Verdict;
  /** Per area, after blocker/major findings raise it to at least `changes`. All `escalate` without output. */
  verdicts: Verdicts;
  /** Distinct reasons, in ESCALATION_REASONS order. Non-empty exactly when `overall` is `escalate`. */
  escalations: EscalationReason[];
}

/**
 * The harness's verdict for one review (pure). `output` is the parsed reviewer output, or null when it was
 * missing or failed parseReviewOutput; pass `status` to say which. Fails closed: no output escalates.
 */
export function overallVerdict(output: ReviewOutput | null, ctx: OverallVerdictContext): OverallVerdictResult {
  const reasons = new Set<EscalationReason>();
  if (ctx.status !== "completed") reasons.add(STATUS_REASON[ctx.status]);
  if (ctx.budgetExhausted) reasons.add("budget-exhausted");
  if (ctx.scanHits.length > 0) reasons.add("scan-hit");

  let verdicts: Verdicts;
  if (output === null) {
    if (ctx.status === "completed") reasons.add("missing-output");
    verdicts = { function: "escalate", security: "escalate", performance: "escalate" };
  } else {
    verdicts = { ...output.verdicts };
    for (const f of output.findings) {
      if (f.area === "meta") {
        reasons.add(f.category === "reviewer-manipulation" ? "reviewer-manipulation" : "unreviewable");
        continue;
      }
      if (f.severity === "blocker" || f.severity === "major") verdicts[f.area] = atLeast(verdicts[f.area], "changes");
      if (f.area === "security" && (ESCALATING_SECURITY_CATEGORIES as readonly string[]).includes(f.category)) {
        reasons.add("security-category");
      }
    }
    if (VERDICT_AREAS.some((a) => verdicts[a] === "escalate")) reasons.add("reviewer-escalated");
  }

  const escalations = ESCALATION_REASONS.filter((r) => reasons.has(r));
  const overall: Verdict =
    escalations.length > 0 ? "escalate" : VERDICT_AREAS.some((a) => verdicts[a] === "changes") ? "changes" : "pass";
  return { overall, verdicts, escalations };
}

const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The review record the harness archives at `gs://globalhost-runs/<repo>/reviews/pr-<n>/<sha>/review.json`.
 * Every field is stamped by trusted code; the merge policy reads verdicts only from here (ADR-0015 §3).
 */
export const ReviewRecordSchema = z.strictObject({
  version: z.literal(1),
  /** The head the harness checked out (`git rev-parse HEAD`), not the reviewer's claim. */
  sha: z.string().regex(GIT_SHA),
  baseSha: z.string().regex(GIT_SHA),
  /** `git patch-id --stable` of base...sha, so a rebase with the same patch can be recognised (ADR-0015 §6). */
  patchId: z.string().regex(GIT_SHA),
  runId: z.string().min(1).max(200),
  /** Null when the run failed before a session existed. */
  sessionId: z.string().min(1).max(200).nullable(),
  /** Pinned model ID, never an alias (ADR-0015 §11). */
  model: z.string().min(1).max(200),
  agentVersion: z.number().int().min(0).nullable(),
  /** The CI run whose success triggered (or preceded) this review. */
  ciRunId: z.number().int().positive().nullable(),
  status: z.enum(REVIEW_STATUSES),
  verdicts: VerdictsSchema,
  overall: VerdictSchema,
  escalations: z.array(z.enum(ESCALATION_REASONS)),
  taint: z.strictObject({ tainted: z.boolean(), reasons: z.array(z.string().max(200)).max(20) }),
  scanHits: z.array(ScanHitSchema).max(MAX_SCAN_HITS),
  findings: z.array(FindingSchema).max(MAX_FINDINGS),
  costUsd: z.number().min(0),
  /** Review spend on this PR including this run. */
  prSpendUsd: z.number().min(0),
  /** Where this record lives in GCS. */
  reviewPath: z.string().min(1).max(500),
  /** The GitHub review this was posted as; null in shadow before posting, or if posting failed. */
  postedReviewId: z.number().int().positive().nullable(),
  recordedAt: z.iso.datetime(),
  /** The verifier's result. Always null until the verifier lands (next slice). */
  verification: z.null(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
