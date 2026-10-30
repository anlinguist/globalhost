import { describe, expect, it } from "vitest";
import {
  applyBudgetNotification,
  parseBudgetNotification,
  shouldPause,
  type BudgetNotification,
  type ControlStore,
} from "../functions/budget-pause/pause.js";

const NAME = "globalhost-factory-monthly";
const NOW = new Date("2026-11-01T12:00:00Z");

/** In-memory GCS object with real generation-match semantics. */
class FakeStore implements ControlStore {
  generation = 0;
  body: string | null = null;
  writes = 0;
  /** Simulate another writer landing between our read and our write, this many times. */
  racesLeft = 0;

  constructor(initial?: unknown) {
    if (initial !== undefined) this.put(typeof initial === "string" ? initial : JSON.stringify(initial));
  }
  private put(body: string) {
    this.body = body;
    this.generation += 1;
  }
  async read() {
    return this.body === null ? null : { body: this.body, generation: String(this.generation) };
  }
  async write(body: string, ifGenerationMatch: string) {
    if (this.racesLeft > 0) {
      this.racesLeft -= 1;
      const other = this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
      this.put(JSON.stringify({ ...other, spendTodayUsd: Number(other.spendTodayUsd ?? 0) + 1 }));
    }
    const current = this.body === null ? "0" : String(this.generation);
    if (ifGenerationMatch !== current) return "conflict" as const;
    this.writes += 1;
    this.put(body);
    return "ok" as const;
  }
  state(): Record<string, unknown> {
    return JSON.parse(this.body ?? "null") as Record<string, unknown>;
  }
}

const msg = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString("base64");
const n = (o: Partial<BudgetNotification>): BudgetNotification => ({
  budgetDisplayName: NAME,
  costAmount: 10,
  budgetAmount: 25,
  ...o,
});
const opts = { expectedBudgetName: NAME, now: NOW };

describe("parseBudgetNotification", () => {
  it("parses a real-shaped budget message", () => {
    const parsed = parseBudgetNotification(
      msg({
        budgetDisplayName: NAME,
        alertThresholdExceeded: 1.0,
        costAmount: 25.31,
        costIntervalStart: "2026-11-01T07:00:00Z",
        budgetAmount: 25.0,
        budgetAmountType: "SPECIFIED_AMOUNT",
        currencyCode: "USD",
      }),
    );
    expect(parsed).toEqual({
      budgetDisplayName: NAME,
      alertThresholdExceeded: 1,
      costAmount: 25.31,
      budgetAmount: 25,
      currencyCode: "USD",
    });
  });

  it.each([
    ["missing data", undefined],
    ["non-base64 JSON garbage", Buffer.from("not json").toString("base64")],
    ["an array", msg([] as unknown as Record<string, unknown>)],
    ["a string cost", msg({ budgetDisplayName: NAME, costAmount: "25", budgetAmount: 25 })],
    ["a missing budget amount", msg({ budgetDisplayName: NAME, costAmount: 25 })],
    ["a NaN-ish threshold", msg({ budgetDisplayName: NAME, costAmount: 1, budgetAmount: 25, alertThresholdExceeded: "1" })],
    ["oversized data", "A".repeat(70 * 1024)],
  ])("rejects %s", (_name, data) => {
    expect(() => parseBudgetNotification(data)).toThrow();
  });
});

describe("shouldPause", () => {
  it.each([
    [n({ costAmount: 10 }), false],
    [n({ costAmount: 10, alertThresholdExceeded: 0.4 }), false],
    [n({ costAmount: 20.5, alertThresholdExceeded: 0.8 }), false],
    [n({ costAmount: 25, alertThresholdExceeded: 1.0 }), true],
    [n({ costAmount: 26 }), true], // a later update after 100% was crossed carries no threshold
    [n({ costAmount: 0, budgetAmount: 0 }), false],
  ])("%o → %s", (notification, expected) => {
    expect(shouldPause(notification)).toBe(expected);
  });
});

describe("applyBudgetNotification", () => {
  it("flips paused on a simulated 100% message and keeps the rest of the state", async () => {
    const store = new FakeStore({ paused: false, spendTodayUsd: 3.2 });
    const notification = parseBudgetNotification(
      msg({ budgetDisplayName: NAME, alertThresholdExceeded: 1.0, costAmount: 25.01, budgetAmount: 25, currencyCode: "USD" }),
    );
    await expect(applyBudgetNotification(store, notification, opts)).resolves.toBe("paused");
    expect(store.state()).toEqual({
      paused: true,
      spendTodayUsd: 3.2,
      pausedBy: "gcp-budget",
      pausedAt: "2026-11-01T12:00:00.000Z",
      pausedReason: "GCP spend 25.01 of 25 USD",
    });
  });

  it("creates the state object if missing, only if it still doesn't exist", async () => {
    const store = new FakeStore();
    await expect(applyBudgetNotification(store, n({ costAmount: 30 }), opts)).resolves.toBe("paused");
    expect(store.state().paused).toBe(true);
  });

  it("does nothing under 100%", async () => {
    const store = new FakeStore({ paused: false });
    await expect(applyBudgetNotification(store, n({ costAmount: 20, alertThresholdExceeded: 0.8 }), opts)).resolves.toBe(
      "under-budget",
    );
    expect(store.writes).toBe(0);
  });

  it("ignores other budgets publishing to the topic", async () => {
    const store = new FakeStore({ paused: false });
    await expect(
      applyBudgetNotification(store, n({ budgetDisplayName: "someone-else", costAmount: 99 }), opts),
    ).resolves.toBe("other-budget");
    expect(store.writes).toBe(0);
  });

  it("is idempotent when already paused (never un-pauses, never rewrites)", async () => {
    const store = new FakeStore({ paused: true, pausedBy: "owner" });
    await expect(applyBudgetNotification(store, n({ costAmount: 30 }), opts)).resolves.toBe("already-paused");
    expect(store.writes).toBe(0);
    expect(store.state().pausedBy).toBe("owner");
  });

  it("re-reads and retries when another writer wins the race, keeping their change", async () => {
    const store = new FakeStore({ paused: false, spendTodayUsd: 1 });
    store.racesLeft = 2;
    await expect(applyBudgetNotification(store, n({ costAmount: 30 }), opts)).resolves.toBe("paused");
    expect(store.state()).toMatchObject({ paused: true, spendTodayUsd: 3 });
    expect(store.writes).toBe(1);
  });

  it("throws (so Pub/Sub retries) after too many conflicts", async () => {
    const store = new FakeStore({ paused: false });
    store.racesLeft = 10;
    await expect(applyBudgetNotification(store, n({ costAmount: 30 }), { ...opts, maxAttempts: 3 })).rejects.toThrow(
      /concurrently/,
    );
    expect(store.writes).toBe(0);
  });

  it.each([["not json"], ["[1,2]"], ["null"]])("fails closed on unparseable state %j", async (body) => {
    const store = new FakeStore(body);
    await expect(applyBudgetNotification(store, n({ costAmount: 30 }), opts)).resolves.toBe("paused");
    expect(store.state()).toMatchObject({ paused: true, previousStateUnparseable: true });
  });

  it("does not let a string \"true\" count as paused", async () => {
    const store = new FakeStore({ paused: "true" });
    await expect(applyBudgetNotification(store, n({ costAmount: 30 }), opts)).resolves.toBe("paused");
    expect(store.state().paused).toBe(true);
  });
});
