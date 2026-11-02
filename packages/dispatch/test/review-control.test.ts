// Review claims and the per-PR review ledger in the control bucket, against the fake GCS in fakes.ts.
import { describe, expect, it } from "vitest";
import { ShadowEntrySchema, canStartReview, type ShadowEntry } from "@globalhost/core";
import { CONTROL_BUCKET, ControlPlane, ObjectStore, reviewClaimObject, reviewLedgerObject, type ReviewHead } from "../src/gcp.js";
import { FakeCloud, REPO } from "./fakes.js";

const token = async () => "gcp-token";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const head: ReviewHead = { repo: REPO, pr: 7, sha: SHA };
const CLAIM = `${CONTROL_BUCKET}/reviews/${REPO}/pr-7/${SHA}.claim.json`;
const LEDGER = `${CONTROL_BUCKET}/reviews/${REPO}/pr-7.json`;

/** A FakeCloud whose fetch also counts GCS precondition failures, so tests can show a race really happened. */
function cloudWithConflicts() {
  const cloud = new FakeCloud();
  const stats = { conflicts: 0 };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const resp = await cloud.fetch(input, init);
    if (resp.status === 412) stats.conflicts++;
    return resp;
  }) as typeof fetch;
  return { cloud, stats, store: new ObjectStore(token, fetchImpl) };
}

function entry(runId: string, costUsd: number, over: Partial<ShadowEntry> = {}): ShadowEntry {
  return ShadowEntrySchema.parse({
    sha: SHA,
    patchId: "c".repeat(40),
    baseSha: "b".repeat(40),
    runId,
    sessionId: `sesn_${runId}`,
    agentVersion: 1,
    model: "claude-opus-5-5",
    ciRunId: 42,
    status: "completed",
    verdicts: { function: "pass", security: "pass", performance: "pass" },
    overall: "pass",
    escalations: [],
    taint: { tainted: true, reasons: ["registry-egress"] },
    scanHits: [],
    costUsd,
    prSpendUsd: 0,
    reviewPath: `${REPO}/reviews/pr-7/${SHA}/review.json`,
    postedReviewId: null,
    recordedAt: "2026-11-02T12:00:00.000Z",
    ...over,
  });
}

describe("review object names", () => {
  it("keys by repo, PR and head SHA", () => {
    expect(reviewClaimObject(head)).toBe(`reviews/${REPO}/pr-7/${SHA}.claim.json`);
    expect(reviewLedgerObject(head)).toBe(`reviews/${REPO}/pr-7.json`);
  });

  it("lowercases the repo so one PR has one budget", () => {
    expect(reviewLedgerObject({ repo: "AnLinguist/Demo", pr: 7 })).toBe(reviewLedgerObject({ repo: "anlinguist/demo", pr: 7 }));
  });

  it("accepts GitHub's repo name characters", () => {
    expect(reviewLedgerObject({ repo: "a-b/.github", pr: 1 })).toBe("reviews/a-b/.github/pr-1.json");
    expect(reviewLedgerObject({ repo: "o/my_repo.js", pr: 1 })).toBe("reviews/o/my_repo.js/pr-1.json");
  });

  it.each<[string, unknown]>([
    ["parent traversal", "o/.."],
    ["dot name", "o/."],
    ["dot-dot inside the name", "o/a..b"],
    ["extra segment", "o/r/../../state"],
    ["no slash", "anlinguist"],
    ["empty owner", "/r"],
    ["owner starting with a hyphen", "-o/r"],
    ["backslash", "o\\r"],
    ["percent-encoding", "o/%2e%2e"],
    ["newline", "o/r\n"],
    ["space", "o/r x"],
    ["unicode lookalike slash", "o∕r"],
    ["owner too long", `${"o".repeat(40)}/r`],
    ["name too long", `o/${"r".repeat(101)}`],
    ["not a string", 42],
  ])("rejects repo: %s", (_name, repo) => {
    expect(() => reviewLedgerObject({ repo: repo as string, pr: 1 })).toThrow(/owner\/name/);
    expect(() => reviewClaimObject({ repo: repo as string, pr: 1, sha: SHA })).toThrow(/owner\/name/);
  });

  it.each<[string, unknown]>([
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", 2 ** 53],
    ["numeric string", "7"],
    ["traversal string", "7/../../x"],
  ])("rejects pr: %s", (_name, pr) => {
    expect(() => reviewLedgerObject({ repo: REPO, pr: pr as number })).toThrow(/positive integer/);
  });

  it.each<[string, unknown]>([
    ["short", "abc"],
    ["uppercase", SHA.toUpperCase()],
    ["64 hex", "a".repeat(64)],
    ["41 hex", `${SHA}0`],
    ["traversal", `../../${SHA.slice(6)}`],
    ["trailing newline", `${SHA}\n`],
    ["not a string", 1],
  ])("rejects sha: %s", (_name, sha) => {
    expect(() => reviewClaimObject({ repo: REPO, pr: 7, sha: sha as string })).toThrow(/sha/);
  });

  it("validates before touching the bucket", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    await expect(control.reviewClaim({ repo: "o/..", pr: 7, sha: SHA }, "r", 60)).rejects.toThrow();
    await expect(control.recordReviewRun({ repo: REPO, pr: -1 }, entry("r", 1))).rejects.toThrow();
    await expect(control.prReviewSpend({ repo: "../x", pr: 1 })).rejects.toThrow();
    expect(cloud.objects.size).toBe(0);
  });
});

describe("review claim", () => {
  it("is create-only: the first run claims, a second is refused and sees the holder", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => new Date("2026-11-02T12:00:00Z"));
    const a = await control.reviewClaim(head, "run-a", 75);
    expect(a).toMatchObject({ claimed: true, claim: { runId: "run-a", sha: SHA, previousRunId: null, recordPath: null } });
    const b = await control.reviewClaim(head, "run-b", 75);
    expect(b).toMatchObject({ claimed: false, existing: { runId: "run-a" } });
    expect(JSON.parse(cloud.objects.get(CLAIM)!.body)).toMatchObject({ runId: "run-a" });
  });

  it("claims each SHA separately", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    expect((await control.reviewClaim(head, "run-a", 75)).claimed).toBe(true);
    expect((await control.reviewClaim({ ...head, sha: "f".repeat(40) }, "run-b", 75)).claimed).toBe(true);
  });

  it("lets exactly one of several concurrent runs claim", async () => {
    const { store, stats } = cloudWithConflicts();
    const control = new ControlPlane(store);
    const results = await Promise.all(["a", "b", "c", "d"].map((r) => control.reviewClaim(head, `run-${r}`, 75)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(stats.conflicts).toBe(3);
  });

  it("takes over a stale, uncompleted claim and records whose it was", async () => {
    const cloud = new FakeCloud();
    let now = new Date("2026-11-02T12:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    await control.reviewClaim(head, "crashed", 75);
    now = new Date("2026-11-02T13:15:00Z"); // exactly 75 minutes: not yet stale
    expect(await control.reviewClaim(head, "early", 75)).toMatchObject({ claimed: false });
    now = new Date("2026-11-02T13:15:01Z");
    expect(await control.reviewClaim(head, "next", 75)).toMatchObject({ claimed: true, claim: { runId: "next", previousRunId: "crashed" } });
    // The crashed run can no longer complete it.
    expect(await control.completeReviewClaim(head, "crashed", "x/review.json")).toBe(false);
  });

  it("lets only one of two concurrent runs take over a stale claim", async () => {
    const { store, stats } = cloudWithConflicts();
    let now = new Date("2026-11-02T12:00:00Z");
    const control = new ControlPlane(store, () => now);
    await control.reviewClaim(head, "crashed", 75);
    now = new Date("2026-11-02T18:00:00Z");
    stats.conflicts = 0;
    const [x, y] = await Promise.all([control.reviewClaim(head, "x", 75), control.reviewClaim(head, "y", 75)]);
    expect([x.claimed, y.claimed].sort()).toEqual([false, true]);
    const loser = x.claimed ? y : x;
    const winner = x.claimed ? "x" : "y";
    expect(loser).toMatchObject({ claimed: false, existing: { runId: winner, previousRunId: "crashed" } });
    expect(stats.conflicts).toBeGreaterThanOrEqual(3); // both creates, then the losing takeover
  });

  it("never takes over a completed claim, however old", async () => {
    let now = new Date("2026-11-02T12:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch), () => now);
    await control.reviewClaim(head, "done", 75);
    const path = `${REPO}/reviews/pr-7/${SHA}/review.json`;
    expect(await control.completeReviewClaim(head, "done", path)).toBe(true);
    now = new Date("2026-12-02T12:00:00Z");
    expect(await control.reviewClaim(head, "late", 75)).toMatchObject({
      claimed: false,
      existing: { runId: "done", recordPath: path, completedAt: "2026-11-02T12:00:00.000Z" },
    });
  });

  it("completes only for the holder, and idempotently", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    expect(await control.completeReviewClaim(head, "nobody", "p/review.json")).toBe(false);
    await control.reviewClaim(head, "run-a", 75);
    expect(await control.completeReviewClaim(head, "run-b", "p/review.json")).toBe(false);
    expect(await control.completeReviewClaim(head, "run-a", "p/review.json")).toBe(true);
    expect(await control.completeReviewClaim(head, "run-a", "p/review.json")).toBe(true);
    expect(await control.completeReviewClaim(head, "run-a", "q/review.json")).toBe(false);
  });

  it("fails closed on a corrupt claim: no takeover, existing is null", async () => {
    const cloud = new FakeCloud();
    cloud.objects.set(CLAIM, { body: "{not json", generation: 1 });
    let now = new Date("2026-11-02T12:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    now = new Date("2027-01-01T00:00:00Z");
    expect(await control.reviewClaim(head, "run-a", 75)).toEqual({ claimed: false, existing: null });
    expect(cloud.objects.get(CLAIM)!.body).toBe("{not json");
  });
});

describe("review ledger", () => {
  it("starts at zero and accumulates cost, restamping prSpendUsd with the running total", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    expect(await control.prReviewSpend(head)).toBe(0);
    expect(await control.reviewLedger(head)).toBeNull();
    const first = await control.recordReviewRun(head, entry("r1", 1.1, { prSpendUsd: 99 }));
    expect(first.prSpendUsd).toBe(1.1);
    const second = await control.recordReviewRun(head, entry("r2", 0.2));
    expect(second.prSpendUsd).toBe(1.3);
    expect(await control.prReviewSpend(head)).toBe(1.3);
    const ledger = await control.reviewLedger(head);
    expect(ledger?.runs.map((r) => [r.runId, r.prSpendUsd])).toEqual([
      ["r1", 1.1],
      ["r2", 1.3],
    ]);
    expect(cloud.objects.has(LEDGER)).toBe(true);
  });

  it("is idempotent per runId", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    const stored = await control.recordReviewRun(head, entry("r1", 2));
    expect(await control.recordReviewRun(head, entry("r1", 2))).toEqual(stored);
    expect(await control.recordReviewRun(head, entry("r1", 5))).toEqual(stored); // a retry can't change the cost
    expect(await control.prReviewSpend(head)).toBe(2);
    expect((await control.reviewLedger(head))?.runs).toHaveLength(1);
  });

  it("counts every cost under concurrent updates", async () => {
    const { store, stats } = cloudWithConflicts();
    const control = new ControlPlane(store);
    const costs = [1.25, 0.5, 2, 0.75, 1.5];
    await Promise.all(costs.map((c, i) => control.recordReviewRun(head, entry(`r${i}`, c))));
    expect(stats.conflicts).toBeGreaterThan(0);
    expect(await control.prReviewSpend(head)).toBe(6);
    const ledger = await control.reviewLedger(head);
    expect(ledger?.runs.map((r) => r.runId).sort()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(ledger?.runs.map((r) => r.prSpendUsd).sort((a, b) => a - b).at(-1)).toBe(6);
  });

  it("records the same run only once when it races itself", async () => {
    const control = new ControlPlane(cloudWithConflicts().store);
    await Promise.all([control.recordReviewRun(head, entry("r1", 3)), control.recordReviewRun(head, entry("r1", 3))]);
    expect(await control.prReviewSpend(head)).toBe(3);
  });

  it("keeps PRs separate", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    await control.recordReviewRun(head, entry("r1", 3));
    expect(await control.prReviewSpend({ repo: REPO, pr: 8 })).toBe(0);
  });

  it("rejects an invalid entry without writing", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    await expect(control.recordReviewRun(head, { ...entry("r1", 1), costUsd: -1 })).rejects.toThrow();
    await expect(control.recordReviewRun(head, { ...entry("r1", 1), findings: [] } as ShadowEntry)).rejects.toThrow();
    expect(cloud.objects.size).toBe(0);
  });

  it("treats a corrupt ledger as over budget, and refuses to write over it", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    for (const body of ["{oops", JSON.stringify({ version: 1, reviewSpendUsd: -3, runs: [] }), JSON.stringify({ reviewSpendUsd: 0 })]) {
      cloud.objects.set(LEDGER, { body, generation: 1 });
      expect(await control.prReviewSpend(head)).toBe(Number.POSITIVE_INFINITY);
      expect(canStartReview({ spent: await control.prReviewSpend(head), perRun: 2, perPr: 8 })).toBe(false);
      await expect(control.recordReviewRun(head, entry("r1", 1))).rejects.toThrow(/fix it by hand/);
      await expect(control.reviewLedger(head)).rejects.toThrow(/fix it by hand/);
      expect(cloud.objects.get(LEDGER)!.body).toBe(body);
    }
  });

  it("gates a review on the ledger: allowed exactly at the cap, refused past it", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    await control.recordReviewRun(head, entry("r1", 3));
    await control.recordReviewRun(head, entry("r2", 3));
    expect(canStartReview({ spent: await control.prReviewSpend(head), perRun: 2, perPr: 8 })).toBe(true);
    await control.recordReviewRun(head, entry("r3", 0.01));
    expect(canStartReview({ spent: await control.prReviewSpend(head), perRun: 2, perPr: 8 })).toBe(false);
  });
});
