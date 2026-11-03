// Review claims and the per-PR review ledger in the control bucket, against the fake GCS in fakes.ts.
import { describe, expect, it } from "vitest";
import { MAX_LEDGER_RUNS, ShadowEntrySchema, canStartReview, type ShadowEntry } from "@globalhost/core";
import {
  CONTROL_BUCKET,
  ControlPlane,
  ObjectStore,
  minReviewStaleMinutes,
  reviewArchivePrefix,
  reviewClaimObject,
  reviewLedgerObject,
  reviewRecordPath,
  type ReviewHead,
} from "../src/gcp.js";
import { FakeCloud, REPO } from "./fakes.js";

const token = async () => "gcp-token";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const head: ReviewHead = { repo: REPO, pr: 7, sha: SHA };
const CLAIM = `${CONTROL_BUCKET}/reviews/${REPO}/pr-7/${SHA}.claim.json`;
/** limits.perRunMinutes 45 → claims go stale after 75 minutes. */
const opts = { perRunMinutes: 45 };
const budget = { perRun: 2, perPr: 8, dailyUsd: 6 };
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

  it("builds per-attempt archive paths and rejects unsafe run IDs", () => {
    expect(reviewArchivePrefix(head, "run-1")).toBe(`${REPO}/reviews/pr-7/${SHA}/run-1/`);
    expect(reviewRecordPath(head, "run-1")).toBe(`${REPO}/reviews/pr-7/${SHA}/run-1/review.json`);
    // A repo named like the path's own segments stays in its place.
    expect(reviewArchivePrefix({ repo: "o/pr-1", pr: 2, sha: SHA }, "r")).toBe(`o/pr-1/reviews/pr-2/${SHA}/r/`);
    for (const bad of ["", "..", "a/b", "../x", ".hidden", "a b", "x".repeat(101), "r\n"]) {
      expect(() => reviewArchivePrefix(head, bad)).toThrow(/runId/);
    }
  });

  it("sets the stale window from perRunMinutes and refuses anything outside its range", () => {
    expect(minReviewStaleMinutes(45)).toBe(75);
    for (const bad of [0, 4, 181, 4.5, Number.NaN]) expect(() => minReviewStaleMinutes(bad)).toThrow(/perRunMinutes/);
  });

  it("validates before touching the bucket", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    await expect(control.reviewClaim({ repo: "o/..", pr: 7, sha: SHA }, "r", opts)).rejects.toThrow();
    await expect(control.reviewClaim(head, "../r", opts)).rejects.toThrow();
    await expect(control.reviewClaim(head, "r", { perRunMinutes: 1 })).rejects.toThrow();
    await expect(control.recordReviewRun({ repo: REPO, pr: -1 }, entry("r", 1))).rejects.toThrow();
    await expect(control.reserveReview({ ...head, sha: "x" }, "r", budget)).rejects.toThrow();
    await expect(control.reserveReview(head, "r", { ...budget, perRun: Number.NaN })).rejects.toThrow();
    await expect(control.prReviewSpend({ repo: "../x", pr: 1 })).rejects.toThrow();
    expect(cloud.objects.size).toBe(0);
  });
});

describe("review claim", () => {
  const at = (iso: string) => new Date(iso);

  it("is create-only: the first run claims, a second is refused and sees the holder", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => at("2026-11-02T12:00:00Z"));
    const a = await control.reviewClaim(head, "run-a", opts);
    expect(a).toMatchObject({ claimed: true, claim: { runId: "run-a", sha: SHA, attempt: 1, previousRunId: null, recordPath: null } });
    expect(await control.reviewClaim(head, "run-b", opts)).toMatchObject({ claimed: false, reason: "in-flight", existing: { runId: "run-a" } });
    expect(await control.reviewClaim(head, "run-a", opts)).toMatchObject({ claimed: true, claim: { runId: "run-a", attempt: 1 } });
    expect(JSON.parse(cloud.objects.get(CLAIM)!.body)).toMatchObject({ runId: "run-a" });
  });

  it("claims each SHA separately", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    expect((await control.reviewClaim(head, "run-a", opts)).claimed).toBe(true);
    expect((await control.reviewClaim({ ...head, sha: "f".repeat(40) }, "run-b", opts)).claimed).toBe(true);
  });

  it("lets exactly one of several concurrent runs claim", async () => {
    const { store, stats } = cloudWithConflicts();
    const control = new ControlPlane(store);
    const results = await Promise.all(["a", "b", "c", "d"].map((r) => control.reviewClaim(head, `run-${r}`, opts)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(stats.conflicts).toBe(3);
  });

  it("takes over a stale, uncompleted claim after perRunMinutes + 30", async () => {
    let now = at("2026-11-02T12:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch), () => now);
    await control.reviewClaim(head, "crashed", opts);
    now = at("2026-11-02T13:15:00Z"); // exactly 75 minutes: not yet stale
    expect(await control.reviewClaim(head, "early", opts)).toMatchObject({ claimed: false, reason: "in-flight" });
    now = at("2026-11-02T13:15:01Z");
    expect(await control.reviewClaim(head, "next", opts)).toMatchObject({
      claimed: true,
      claim: { runId: "next", attempt: 2, previousRunId: "crashed" },
    });
    // The crashed run can no longer complete it, so it must not post.
    expect(await control.completeReviewClaim(head, "crashed")).toBe(false);
  });

  it("judges staleness by the holder's stored perRunMinutes, not a limit lowered mid-run", async () => {
    let now = at("2026-11-02T12:00:00Z");
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    await control.reviewClaim(head, "live", { perRunMinutes: 180 });
    expect(JSON.parse(cloud.objects.get(CLAIM)!.body)).toMatchObject({ perRunMinutes: 180 });
    // The owner lowers limits.perRunMinutes to 45 (window 75 min); the live run still has 180 + 30.
    now = at("2026-11-02T13:30:00Z");
    expect(await control.reviewClaim(head, "eager", { perRunMinutes: 45 })).toMatchObject({ claimed: false, reason: "in-flight" });
    now = at("2026-11-02T15:30:00Z"); // exactly 210 minutes: not yet stale
    expect(await control.reviewClaim(head, "eager", { perRunMinutes: 45 })).toMatchObject({ claimed: false, reason: "in-flight" });
    now = at("2026-11-02T15:30:01Z");
    expect(await control.reviewClaim(head, "next", { perRunMinutes: 45 })).toMatchObject({
      claimed: true,
      claim: { runId: "next", attempt: 2, previousRunId: "live", perRunMinutes: 45 },
    });
  });

  it("falls back to the current perRunMinutes for a claim written without one", async () => {
    let now = at("2026-11-02T12:00:00Z");
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    await control.reviewClaim(head, "old", opts);
    const obj = cloud.objects.get(CLAIM)!;
    const legacy = JSON.parse(obj.body) as Record<string, unknown>;
    delete legacy.perRunMinutes;
    obj.body = JSON.stringify(legacy);
    now = at("2026-11-02T13:15:01Z"); // past 45 + 30
    expect(await control.reviewClaim(head, "next", opts)).toMatchObject({ claimed: true, claim: { previousRunId: "old" } });
  });

  it("lets only one of two concurrent runs take over a stale claim", async () => {
    const { store, stats } = cloudWithConflicts();
    let now = at("2026-11-02T12:00:00Z");
    const control = new ControlPlane(store, () => now);
    await control.reviewClaim(head, "crashed", opts);
    now = at("2026-11-02T18:00:00Z");
    stats.conflicts = 0;
    const [x, y] = await Promise.all([control.reviewClaim(head, "x", opts), control.reviewClaim(head, "y", opts)]);
    expect([x.claimed, y.claimed].sort()).toEqual([false, true]);
    const loser = x.claimed ? y : x;
    expect(loser).toMatchObject({ claimed: false, reason: "lost-race", existing: { runId: x.claimed ? "x" : "y", previousRunId: "crashed" } });
    expect(stats.conflicts).toBeGreaterThanOrEqual(3); // both creates, then the losing takeover
  });

  it("never takes over a completed claim, however old, without a re-review", async () => {
    let now = at("2026-11-02T12:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch), () => now);
    await control.reviewClaim(head, "done", opts);
    expect(await control.completeReviewClaim(head, "done")).toBe(true);
    now = at("2026-12-02T12:00:00Z");
    expect(await control.reviewClaim(head, "late", opts)).toMatchObject({
      claimed: false,
      reason: "completed",
      existing: { runId: "done", recordPath: reviewRecordPath(head, "done"), completedAt: "2026-11-02T12:00:00.000Z" },
    });
  });

  it("re-reviews a completed SHA as the next attempt, but never displaces an in-flight one", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch), () => at("2026-11-02T12:00:00Z"));
    await control.reviewClaim(head, "first", opts);
    expect(await control.reviewClaim(head, "eager", { ...opts, rereview: true })).toMatchObject({ claimed: false, reason: "in-flight" });
    await control.completeReviewClaim(head, "first");
    const again = await control.reviewClaim(head, "second", { ...opts, rereview: true });
    expect(again).toMatchObject({ claimed: true, claim: { runId: "second", attempt: 2, previousRunId: "first", recordPath: null } });
    expect(await control.reviewClaim(head, "third", { ...opts, rereview: true })).toMatchObject({ claimed: false, reason: "in-flight" });
    // The first attempt can't complete (or post) again; the second completes at its own path.
    expect(await control.completeReviewClaim(head, "first")).toBe(false);
    expect(await control.completeReviewClaim(head, "second")).toBe(true);
    expect((await control.reviewClaim(head, "x", opts)).claimed).toBe(false);
  });

  it("completes only for the holder, and idempotently", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    expect(await control.completeReviewClaim(head, "nobody")).toBe(false);
    await control.reviewClaim(head, "run-a", opts);
    expect(await control.completeReviewClaim(head, "run-b")).toBe(false);
    expect(await control.completeReviewClaim(head, "run-a")).toBe(true);
    expect(await control.completeReviewClaim(head, "run-a")).toBe(true);
  });

  it("fails closed on a corrupt claim: no takeover, no re-review, reason corrupt", async () => {
    const cloud = new FakeCloud();
    cloud.objects.set(CLAIM, { body: "{not json", generation: 1 });
    let now = at("2026-11-02T12:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    now = at("2027-01-01T00:00:00Z");
    expect(await control.reviewClaim(head, "run-a", opts)).toEqual({ claimed: false, existing: null, reason: "corrupt" });
    expect(await control.reviewClaim(head, "run-a", { ...opts, rereview: true })).toMatchObject({ reason: "corrupt" });
    expect(cloud.objects.get(CLAIM)!.body).toBe("{not json");
  });
});

describe("review reservations", () => {
  const DAY = "2026-11-02";
  const DAILY = `${CONTROL_BUCKET}/spend/${DAY}/anlinguist__demo.json`;
  const daily = (cloud: FakeCloud) => JSON.parse(cloud.objects.get(DAILY)?.body ?? "{}") as { usd?: number; reservations?: unknown[]; runs?: unknown[] };
  const clock = () => new Date(`${DAY}T12:00:00Z`);

  it("reserves the per-run cap on the PR ledger and the daily record", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), clock);
    const r = await control.reserveReview(head, "r1", budget);
    expect(r).toMatchObject({ reserved: true, reservation: { runId: "r1", sha: SHA, reservedUsd: 2, day: DAY } });
    expect((await control.reviewLedger(head))?.reservations).toHaveLength(1);
    expect(daily(cloud).reservations).toEqual([{ runId: "r1", usd: 2, at: `${DAY}T12:00:00.000Z` }]);
    expect(await control.spentTodayUsd(REPO)).toBe(2); // builders see review holds too
    expect(await control.reserveReview(head, "r1", budget)).toMatchObject({ reserved: true }); // idempotent
    expect(daily(cloud).reservations).toHaveLength(1);
  });

  it("admits only floor((perPr - spent) / perRun) concurrent reviews across SHAs", async () => {
    const { store, stats } = cloudWithConflicts();
    const control = new ControlPlane(store, clock);
    await control.reserveReview(head, "r0", { ...budget, dailyUsd: 100 });
    await control.recordReviewRun(head, entry("r0", 1.5)); // spent 1.5 → room for floor(6.5 / 2) = 3
    const shas = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(40));
    const results = await Promise.all(shas.map((sha, i) => control.reserveReview({ ...head, sha }, `c${i}`, { ...budget, dailyUsd: 100 })));
    expect(stats.conflicts).toBeGreaterThan(0);
    expect(results.filter((r) => r.reserved)).toHaveLength(3);
    expect(results.filter((r) => !r.reserved).every((r) => !r.reserved && r.reason === "pr-budget")).toBe(true);
    expect((await control.reviewLedger(head))?.reservations).toHaveLength(3);
  });

  it("refuses at the daily cap and releases the PR hold again", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), clock);
    await control.recordSpend(REPO, "builder-1", 3.5); // builder spend shares dailyUsd
    expect(await control.reserveReview(head, "r1", budget)).toMatchObject({ reserved: true }); // 3.5 + 2 ≤ 6
    const other = { repo: REPO, pr: 8, sha: SHA };
    expect(await control.reserveReview(other, "r2", budget)).toEqual({ reserved: false, reason: "daily-budget", committedUsd: 5.5 });
    expect((await control.reviewLedger(other))?.reservations).toEqual([]);
    expect(daily(cloud)).toMatchObject({ usd: 3.5, runs: [{ runId: "builder-1", usd: 3.5 }] });
  });

  it("keeps review holds when a builder records spend", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), clock);
    await control.reserveReview(head, "r1", budget);
    await control.recordSpend(REPO, "builder-1", 1);
    expect(daily(cloud).reservations).toHaveLength(1);
    expect(await control.spentTodayUsd(REPO)).toBe(3);
  });

  it("treats a corrupt daily record as over budget", async () => {
    const cloud = new FakeCloud();
    cloud.objects.set(DAILY, { body: JSON.stringify({ usd: "lots" }), generation: 1 });
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), clock);
    expect(await control.reserveReview(head, "r1", budget)).toMatchObject({ reserved: false, reason: "daily-budget" });
    expect(await control.spentTodayUsd(REPO)).toBe(Number.POSITIVE_INFINITY);
    expect((await control.reviewLedger(head))?.reservations).toEqual([]);
  });

  it("keeps a crashed run's reservation counted until an owner releases it", async () => {
    let now = clock();
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    const wide = { ...budget, dailyUsd: 100 };
    await control.reserveReview(head, "crashed", wide);
    now = new Date("2026-11-20T00:00:00Z"); // weeks later, still held
    const ledger = await control.reviewLedger(head);
    expect(ledger?.reservations.map((r) => r.runId)).toEqual(["crashed"]);
    expect(await control.reserveReview(head, "a", wide)).toMatchObject({ reserved: true });
    expect(await control.reserveReview(head, "b", wide)).toMatchObject({ reserved: true });
    expect(await control.reserveReview(head, "c", wide)).toMatchObject({ reserved: true }); // 2 + 3 × 2 = 8: exactly at the cap
    expect(await control.reserveReview(head, "d", wide)).toMatchObject({ reserved: false, reason: "pr-budget", committedUsd: 8 });
    expect(await control.releaseStaleReservation(head, "crashed")).toBe(true);
    expect(await control.releaseStaleReservation(head, "crashed")).toBe(false);
    expect(daily(cloud).reservations).toEqual([]); // released on the reservation's own day
    expect(await control.reserveReview(head, "d", wide)).toMatchObject({ reserved: true });
    expect(await control.prReviewSpend(head)).toBe(0);
  });

  it("settles with the actual cost, below or above the reservation, on the reservation's day", async () => {
    let now = clock();
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    await control.reserveReview(head, "cheap", budget);
    await control.reserveReview(head, "dear", budget);
    now = new Date("2026-11-03T01:00:00Z"); // settled after midnight: still charged to the reservation's day
    await control.recordReviewRun(head, entry("cheap", 0.4));
    await control.recordReviewRun(head, entry("dear", 2.3));
    const ledger = await control.reviewLedger(head);
    expect(ledger).toMatchObject({ reviewSpendUsd: 2.7, reservations: [] });
    expect(daily(cloud)).toMatchObject({ usd: 2.7, reservations: [] });
    expect(cloud.objects.has(`${CONTROL_BUCKET}/spend/2026-11-03/anlinguist__demo.json`)).toBe(false);
  });

  it("settles idempotently, and a settled run can't reserve again", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), clock);
    await control.reserveReview(head, "r1", budget);
    const stored = await control.recordReviewRun(head, entry("r1", 1));
    expect(await control.recordReviewRun(head, entry("r1", 1))).toEqual(stored);
    expect(await control.recordReviewRun(head, entry("r1", 5))).toEqual(stored); // a retry can't change the cost
    expect(daily(cloud)).toMatchObject({ usd: 1, reservations: [] });
    expect(daily(cloud).runs).toHaveLength(1);
    expect(await control.reserveReview(head, "r1", budget)).toMatchObject({ reserved: false, reason: "already-recorded" });
  });

  it("settles the daily record once when the ledger write is retried after a crash", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), clock);
    await control.reserveReview(head, "r1", budget);
    // Simulate a crash after the daily settle but before the ledger settle: settle daily only.
    const ledgerBefore = cloud.objects.get(LEDGER)!;
    await control.recordReviewRun(head, entry("r1", 1.25));
    cloud.objects.set(LEDGER, ledgerBefore);
    await control.recordReviewRun(head, entry("r1", 1.25));
    expect(daily(cloud)).toMatchObject({ usd: 1.25, reservations: [] });
    expect(await control.prReviewSpend(head)).toBe(1.25);
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

  it("moves dropped runs' cost into truncatedSpendUsd so the total still adds up", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    const runs = Array.from({ length: MAX_LEDGER_RUNS }, (_, i) => entry(`old-${i}`, 0.01));
    const full = { version: 1, reviewSpendUsd: 2, truncatedSpendUsd: 0, runs, reservations: [] };
    cloud.objects.set(LEDGER, { body: JSON.stringify(full), generation: 1 });
    await control.recordReviewRun(head, entry("new", 1));
    const ledger = await control.reviewLedger(head);
    expect(ledger).toMatchObject({ reviewSpendUsd: 3, truncatedSpendUsd: 0.01 });
    expect(ledger?.runs).toHaveLength(MAX_LEDGER_RUNS);
    expect(ledger?.runs[0]?.runId).toBe("old-1");
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
    await expect(control.recordReviewRun(head, { ...entry("r1", 1), costUsd: 1001 })).rejects.toThrow();
    await expect(control.recordReviewRun(head, { ...entry("r1", 1), findings: [] } as ShadowEntry)).rejects.toThrow();
    expect(cloud.objects.size).toBe(0);
  });

  it("treats a corrupt ledger as over budget, and refuses to write over it", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    const bodies = [
      "{oops",
      JSON.stringify({ version: 1, reviewSpendUsd: -3, truncatedSpendUsd: 0, runs: [], reservations: [] }),
      JSON.stringify({ version: 1, reviewSpendUsd: 0, truncatedSpendUsd: 0, runs: [entry("r", 2)], reservations: [] }), // doesn't add up
      JSON.stringify({ reviewSpendUsd: 0 }),
    ];
    for (const body of bodies) {
      cloud.objects.set(LEDGER, { body, generation: 1 });
      expect(await control.prReviewSpend(head)).toBe(Number.POSITIVE_INFINITY);
      expect(canStartReview({ spent: await control.prReviewSpend(head), perRun: 2, perPr: 8 })).toBe(false);
      await expect(control.recordReviewRun(head, entry("r1", 1))).rejects.toThrow(/fix it by hand/);
      await expect(control.reserveReview(head, "r1", budget)).rejects.toThrow(/fix it by hand/);
      await expect(control.reviewLedger(head)).rejects.toThrow(/fix it by hand/);
      expect(cloud.objects.get(LEDGER)!.body).toBe(body);
    }
  });

  it("gates a review on the ledger: allowed exactly at the cap, refused past it", async () => {
    const control = new ControlPlane(new ObjectStore(token, new FakeCloud().fetch));
    await control.recordReviewRun(head, entry("r1", 3));
    await control.recordReviewRun(head, entry("r2", 3));
    expect(await control.reserveReview(head, "r3", { ...budget, dailyUsd: 100 })).toMatchObject({ reserved: true });
    expect(await control.reserveReview(head, "r4", { ...budget, dailyUsd: 100 })).toMatchObject({ reserved: false, reason: "pr-budget", committedUsd: 8 });
  });
});
