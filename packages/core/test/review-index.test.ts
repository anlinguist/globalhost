import { describe, expect, it } from "vitest";
import {
  addUsd,
  canStartReview,
  committedReviewUsd,
  MAX_LEDGER_RUNS,
  ReviewClaimSchema,
  ReviewLedgerSchema,
  ReviewRecordSchema,
  ShadowEntrySchema,
  shadowEntryFromRecord,
  type ReviewRecord,
  type ShadowEntry,
} from "../src/index.js";

const sha = "a".repeat(40);
const record: ReviewRecord = ReviewRecordSchema.parse({
  version: 1,
  sha,
  baseSha: "b".repeat(40),
  patchId: "c".repeat(40),
  runId: "r-1",
  sessionId: "s-1",
  model: "claude-opus-5-5",
  agentVersion: 3,
  ciRunId: 123,
  status: "completed",
  verdicts: { function: "pass", security: "changes", performance: "pass" },
  overall: "escalate",
  escalations: ["scan-hit"],
  taint: { tainted: true, reasons: ["registry-egress"] },
  scanHits: [
    { code: "reviewer-address", where: "added-line", file: "a.ts", line: 3, excerpt: "note to the reviewer" },
    { code: "ignore-instructions", where: "commit-message", commit: 0 },
    { code: "reviewer-address", where: "path", file: "b.md" },
  ],
  findings: [],
  costUsd: 1.25,
  prSpendUsd: 2.5,
  reviewPath: `globalhost-runs/o/r/reviews/pr-1/${sha}/review.json`,
  postedReviewId: null,
  recordedAt: "2026-11-02T12:00:00.000Z",
  verification: null,
});

describe("shadow index entry", () => {
  const entry = shadowEntryFromRecord(record);

  it("summarises a record: no findings, no excerpts, distinct scan codes in schema order", () => {
    expect(entry.scanHits).toEqual(["reviewer-address", "ignore-instructions"]);
    expect(entry).not.toHaveProperty("findings");
    expect(entry).not.toHaveProperty("verification");
    expect(entry).not.toHaveProperty("version");
    expect(JSON.stringify(entry)).not.toContain("note to the reviewer");
    expect(Object.keys(entry).sort()).toEqual(
      [
        "sha",
        "patchId",
        "baseSha",
        "runId",
        "sessionId",
        "agentVersion",
        "model",
        "ciRunId",
        "status",
        "verdicts",
        "overall",
        "escalations",
        "taint",
        "scanHits",
        "costUsd",
        "prSpendUsd",
        "reviewPath",
        "postedReviewId",
        "recordedAt",
      ].sort(),
    );
  });

  it.each<[string, unknown]>([
    ["unknown key", { ...entry, findings: [] }],
    ["full scan hit objects", { ...entry, scanHits: [{ code: "reviewer-address", where: "path" }] }],
    ["unknown scan code", { ...entry, scanHits: ["approve-me"] }],
    ["duplicate scan codes", { ...entry, scanHits: ["reviewer-address", "reviewer-address"] }],
    ["escalate without reasons", { ...entry, escalations: [] }],
    ["negative cost", { ...entry, costUsd: -0.01 }],
    ["infinite cost", { ...entry, costUsd: Number.POSITIVE_INFINITY }],
    ["short sha", { ...entry, sha: "abc" }],
  ])("rejects %s", (_name, value) => {
    expect(ShadowEntrySchema.safeParse(value).success).toBe(false);
  });
});

describe("review ledger schema", () => {
  const entry: ShadowEntry = shadowEntryFromRecord(record);
  const ledger = (over: Record<string, unknown> = {}) => ({
    version: 1,
    reviewSpendUsd: 1.25,
    truncatedSpendUsd: 0,
    runs: [entry],
    reservations: [],
    ...over,
  });
  const reservation = { runId: "r-2", sha, reservedUsd: 2, reservedAt: "2026-11-02T12:00:00.000Z", day: "2026-11-02" };

  it("accepts a consistent ledger", () => {
    expect(ReviewLedgerSchema.safeParse(ledger()).success).toBe(true);
    expect(ReviewLedgerSchema.safeParse(ledger({ reviewSpendUsd: 1.75, truncatedSpendUsd: 0.5, reservations: [reservation] })).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["duplicate run IDs", { reviewSpendUsd: 2.5, runs: [entry, entry] }],
    ["unknown key", { extra: 1 }],
    ["negative total", { reviewSpendUsd: -1, runs: [] }],
    ["string total", { reviewSpendUsd: "8", runs: [] }],
    ["wrong version", { version: 2 }],
    ["total below the runs' costs", { reviewSpendUsd: 1 }],
    ["total above the runs' costs", { reviewSpendUsd: 1.5 }],
    ["missing truncatedSpendUsd", { truncatedSpendUsd: undefined }],
    ["a settled run still holding a reservation", { reservations: [{ ...reservation, runId: "r-1" }] }],
    ["two reservations for one run", { reservations: [reservation, reservation] }],
    ["reservation over the ceiling", { reservations: [{ ...reservation, reservedUsd: 1001 }] }],
    ["zero reservation", { reservations: [{ ...reservation, reservedUsd: 0 }] }],
    ["reservation with a path in its run ID", { reservations: [{ ...reservation, runId: "../x" }] }],
  ])("rejects %s", (_name, over) => {
    expect(ReviewLedgerSchema.safeParse(ledger(over)).success).toBe(false);
  });

  it("caps the run list", () => {
    const runs = Array.from({ length: MAX_LEDGER_RUNS + 1 }, (_, i) => ({ ...entry, runId: `r-${i}` }));
    expect(ReviewLedgerSchema.safeParse(ledger({ reviewSpendUsd: 1.25 * runs.length, runs })).success).toBe(false);
  });

  it("counts open reservations as committed", () => {
    expect(committedReviewUsd(ReviewLedgerSchema.parse(ledger({ reservations: [reservation] })))).toBe(3.25);
  });

  it("caps any one amount at MAX_REVIEW_USD", () => {
    expect(ShadowEntrySchema.safeParse({ ...entry, costUsd: 1000.01 }).success).toBe(false);
    expect(ReviewRecordSchema.safeParse({ ...record, prSpendUsd: 1000.01 }).success).toBe(false);
  });
});

describe("review claim schema", () => {
  const claim = {
    version: 1,
    sha,
    attempt: 1,
    runId: "r-1",
    claimedAt: "2026-11-02T12:00:00.000Z",
    previousRunId: null,
    completedAt: null,
    recordPath: null,
  };
  it("accepts a claim and rejects a 64-hex or uppercase sha, attempt 0, or a path in the run ID", () => {
    expect(ReviewClaimSchema.safeParse(claim).success).toBe(true);
    expect(ReviewClaimSchema.safeParse({ ...claim, sha: "a".repeat(64) }).success).toBe(false);
    expect(ReviewClaimSchema.safeParse({ ...claim, sha: "A".repeat(40) }).success).toBe(false);
    expect(ReviewClaimSchema.safeParse({ ...claim, attempt: 0 }).success).toBe(false);
    expect(ReviewClaimSchema.safeParse({ ...claim, runId: "a/b" }).success).toBe(false);
  });
});

describe("canStartReview", () => {
  it.each<[string, { spent: number; reserved?: number; perRun: number; perPr: number }, boolean]>([
    ["nothing spent", { spent: 0, perRun: 2, perPr: 8 }, true],
    ["exactly at the cap", { spent: 6, perRun: 2, perPr: 8 }, true],
    ["a cent over", { spent: 6.01, perRun: 2, perPr: 8 }, false],
    ["float noise at the cap (0.1 + 0.2 vs 0.3)", { spent: 0.1, perRun: 0.2, perPr: 0.3 }, true],
    ["already over", { spent: 9, perRun: 2, perPr: 8 }, false],
    ["per-run above per-PR", { spent: 0, perRun: 9, perPr: 8 }, false],
    ["corrupt spend (Infinity)", { spent: Number.POSITIVE_INFINITY, perRun: 2, perPr: 8 }, false],
    ["corrupt spend (NaN)", { spent: Number.NaN, perRun: 2, perPr: 8 }, false],
    ["negative spend", { spent: -5, perRun: 2, perPr: 8 }, false],
    ["zero per-run", { spent: 0, perRun: 0, perPr: 8 }, false],
    ["reservations fill the rest", { spent: 2, reserved: 4, perRun: 2, perPr: 8 }, true],
    ["reservations leave too little", { spent: 2, reserved: 4.01, perRun: 2, perPr: 8 }, false],
    ["corrupt reservations", { spent: 0, reserved: Number.NaN, perRun: 2, perPr: 8 }, false],
  ])("%s", (_name, input, expected) => {
    expect(canStartReview(input)).toBe(expected);
  });
});

describe("addUsd", () => {
  it("adds without float noise", () => {
    expect(addUsd(0.1, 0.2)).toBe(0.3);
    expect(addUsd(1.234567, 0.000001)).toBe(1.234568);
  });
});
