// The reviewer's structured output, the harness-stamped review record, and the pure function that turns them
// into an overall verdict (ADR-0015 §2, §3, §8). The reviewer's output is untrusted: it is parsed strictly and
// rejected (never clipped or repaired) when it doesn't fit, and an invalid output escalates. The record is
// written by trusted code: the SHA is the one the harness checked out, never the reviewer's claim.
import { z } from "zod";
import { isRepoRelativePath } from "./path-policy.js";
import { MAX_SCAN_HITS, scanPhrase, ScanHitSchema, type ScanHit } from "./review-scan.js";

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

export const MAX_FINDING_CODE = 40;
export const MAX_FINDING_FILE = 300;
const FINDING_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * One reviewer finding. `area`, `category`, `code`, `severity`, `file` and `line` are constrained enough to pass
 * to other agents as structured fields (ADR-0015 §7). `title` and `detail` are reviewer-written free text that
 * may quote the diff: anywhere they are shown to an agent they must be fenced as untrusted (packages/sanitize),
 * and they never feed a decision.
 */
export const FindingSchema = z
  .strictObject({
    area: AreaSchema,
    category: z.enum(ALL_CATEGORIES),
    /** A short stable identifier in kebab case, e.g. `missing-null-check`. */
    code: z.string().max(MAX_FINDING_CODE).regex(FINDING_CODE),
    severity: z.enum(SEVERITIES),
    /** Repo-relative path, as git reports it. */
    file: z.string().max(MAX_FINDING_FILE).refine(isRepoRelativePath).nullable(),
    line: z.number().int().min(1).max(10_000_000).nullable(),
    title: z.string().min(1).max(MAX_TITLE),
    detail: z.string().max(MAX_DETAIL),
  })
  .superRefine((f, ctx) => {
    if (!(FINDING_CATEGORIES[f.area] as readonly string[]).includes(f.category)) {
      ctx.addIssue({ code: "custom", path: ["category"], message: "category is not in this area" });
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

export interface ReviewOutputIssue {
  /** Dotted path; any segment that isn't a schema key or an array index is replaced by `<key>`. */
  path: string;
  /** zod's issue code. */
  code: string;
  /** Fixed text per code. Never zod's message, which can quote reviewer-written keys or values. */
  message: string;
}

export type ParseReviewOutputResult = { ok: true; output: ReviewOutput } | { ok: false; issues: ReviewOutputIssue[] };

export const MAX_OUTPUT_ISSUES = 20;
const SCHEMA_KEYS = new Set<string>([
  ...Object.keys(ReviewOutputSchema.shape),
  ...Object.keys(VerdictsSchema.shape),
  "area",
  "category",
  "code",
  "severity",
  "file",
  "line",
  "title",
  "detail",
]);
const ISSUE_MESSAGES: Record<string, string> = {
  invalid_type: "wrong type",
  too_big: "too long or too many",
  too_small: "too short or too small",
  invalid_format: "wrong format",
  invalid_value: "not an allowed value",
  unrecognized_keys: "unknown key",
  custom: "fails a schema rule",
};

/** Validate untrusted reviewer output. Never clips or repairs: anything that doesn't fit is rejected. */
export function parseReviewOutput(raw: unknown): ParseReviewOutputResult {
  const r = ReviewOutputSchema.safeParse(raw);
  if (r.success) return { ok: true, output: r.data };
  const issues = r.error.issues.slice(0, MAX_OUTPUT_ISSUES).map((i) => {
    const code = i.code in ISSUE_MESSAGES ? i.code : "other";
    const path = i.path
      .map((seg) => (typeof seg === "number" || (typeof seg === "string" && SCHEMA_KEYS.has(seg)) ? String(seg) : "<key>"))
      .join(".");
    return { path, code, message: ISSUE_MESSAGES[code] ?? "invalid" };
  });
  return { ok: false, issues };
}

/**
 * Indexes of findings whose `code` reads as reviewer-directed text (scanned as-is and with hyphens as spaces). The code
 * is the one finding field passed on as a structured value, so text smuggled into it escalates.
 */
export function findingCodeHits(findings: readonly Finding[]): number[] {
  const hit = (code: string) => scanPhrase(code).length > 0 || scanPhrase(code.replace(/-/g, " ")).length > 0;
  return findings.flatMap((f, i) => (hit(f.code) ? [i] : []));
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
  /** Set by the verifier step (next slice) when it rejects a security finding (ADR-0015 §4). */
  "verifier-rejected-security",
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
  /**
   * Per area, after blocker/major findings raise it to at least `changes`. All `escalate` when there is no
   * output or the run didn't complete.
   */
  verdicts: Verdicts;
  /** Distinct reasons, in ESCALATION_REASONS order. Non-empty exactly when `overall` is `escalate`. */
  escalations: EscalationReason[];
}

/**
 * The harness's verdict for one review (pure). This is the review's result, not the merge decision: the merge
 * policy (P2-01c) combines it with CI, guardrails, provenance, taint, the verifier and the autonomy level.
 * `output` is the parsed reviewer output, or null when it was
 * missing or failed parseReviewOutput; pass `status` to say which. Fails closed: no output, or a run that
 * didn't complete, escalates every area. A finding whose `code` trips the reviewer-text scan counts as
 * reviewer manipulation.
 */
export function overallVerdict(output: ReviewOutput | null, ctx: OverallVerdictContext): OverallVerdictResult {
  const reasons = new Set<EscalationReason>();
  if (ctx.status !== "completed") reasons.add(STATUS_REASON[ctx.status]);
  if (ctx.budgetExhausted) reasons.add("budget-exhausted");
  if (ctx.scanHits.length > 0) reasons.add("scan-hit");

  if (output === null && ctx.status === "completed") reasons.add("missing-output");
  const failClosed = output === null || ctx.status !== "completed";
  const verdicts: Verdicts =
    failClosed || output === null
      ? { function: "escalate", security: "escalate", performance: "escalate" }
      : { ...output.verdicts };
  if (output !== null) {
    if (findingCodeHits(output.findings).length > 0) reasons.add("reviewer-manipulation");
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
    if (!failClosed && VERDICT_AREAS.some((a) => verdicts[a] === "escalate")) reasons.add("reviewer-escalated");
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
}).superRefine((r, ctx) => {
  // Mirror overallVerdict's invariants so a record that contradicts itself is rejected on read.
  if (new Set(r.escalations).size !== r.escalations.length) {
    ctx.addIssue({ code: "custom", path: ["escalations"], message: "escalations must be unique" });
  }
  if ((r.overall === "escalate") !== (r.escalations.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["overall"], message: "overall is escalate exactly when there are escalations" });
  }
  if (r.status !== "completed" && (r.overall !== "escalate" || VERDICT_AREAS.some((a) => r.verdicts[a] !== "escalate"))) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "a review that didn't complete escalates every area" });
  }
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
