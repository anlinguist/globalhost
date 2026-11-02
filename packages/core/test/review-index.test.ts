import { describe, expect, it } from "vitest";
import {
  addUsd,
  canStartReview,
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

  it("accepts a ledger and rejects duplicate run IDs, unknown keys and corrupt totals", () => {
    expect(ReviewLedgerSchema.safeParse({ version: 1, reviewSpendUsd: 1.25, runs: [entry] }).success).toBe(true);
    expect(ReviewLedgerSchema.safeParse({ version: 1, reviewSpendUsd: 2.5, runs: [entry, entry] }).success).toBe(false);
    expect(ReviewLedgerSchema.safeParse({ version: 1, reviewSpendUsd: 0, runs: [], extra: 1 }).success).toBe(false);
    expect(ReviewLedgerSchema.safeParse({ version: 1, reviewSpendUsd: -1, runs: [] }).success).toBe(false);
    expect(ReviewLedgerSchema.safeParse({ version: 1, reviewSpendUsd: "8", runs: [] }).success).toBe(false);
    expect(ReviewLedgerSchema.safeParse({ version: 2, reviewSpendUsd: 0, runs: [] }).success).toBe(false);
  });

  it("caps the run list", () => {
    const runs = Array.from({ length: MAX_LEDGER_RUNS + 1 }, (_, i) => ({ ...entry, runId: `r-${i}` }));
    expect(ReviewLedgerSchema.safeParse({ version: 1, reviewSpendUsd: 0, runs }).success).toBe(false);
  });
});

describe("review claim schema", () => {
  const claim = {
    version: 1,
    sha,
    runId: "r-1",
    claimedAt: "2026-11-02T12:00:00.000Z",
    previousRunId: null,
    completedAt: null,
    recordPath: null,
  };
  it("accepts a claim and rejects a 64-hex or uppercase sha", () => {
    expect(ReviewClaimSchema.safeParse(claim).success).toBe(true);
    expect(ReviewClaimSchema.safeParse({ ...claim, sha: "a".repeat(64) }).success).toBe(false);
    expect(ReviewClaimSchema.safeParse({ ...claim, sha: "A".repeat(40) }).success).toBe(false);
  });
});

describe("canStartReview", () => {
  it.each<[string, { spent: number; perRun: number; perPr: number }, boolean]>([
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
