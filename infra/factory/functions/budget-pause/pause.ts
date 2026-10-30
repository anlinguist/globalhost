// Pure logic for the budget-pause function: decide from a Cloud Billing budget notification whether
// the factory must pause, and set `paused: true` in the control object with a compare-and-swap write.
// No GCP imports here so it is unit-testable with a fake store.
//
// The message is validated by hand rather than with zod: the deployed function's only dependency is
// the Functions Framework (locked in deploy/package-lock.json), and this payload has five fields.

/** Fields of the budget notification we use (Cloud Billing programmatic notifications, schema 1.0). */
export interface BudgetNotification {
  budgetDisplayName: string;
  costAmount: number;
  budgetAmount: number;
  /** Present only when a threshold was crossed by this update; 1.0 = 100%. */
  alertThresholdExceeded?: number;
  currencyCode?: string;
}

export function parseBudgetNotification(base64Data: unknown): BudgetNotification {
  if (typeof base64Data !== "string" || base64Data.length === 0 || base64Data.length > 64 * 1024) {
    throw new Error("budget notification: missing or oversized message data");
  }
  const parsed: unknown = JSON.parse(Buffer.from(base64Data, "base64").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("budget notification: data is not a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`budget notification: ${k} is not a number`);
    return v;
  };
  if (typeof o.budgetDisplayName !== "string") throw new Error("budget notification: budgetDisplayName missing");
  const result: BudgetNotification = {
    budgetDisplayName: o.budgetDisplayName,
    costAmount: num("costAmount"),
    budgetAmount: num("budgetAmount"),
  };
  if (o.alertThresholdExceeded !== undefined) result.alertThresholdExceeded = num("alertThresholdExceeded");
  if (typeof o.currencyCode === "string") result.currencyCode = o.currencyCode;
  return result;
}

/** Pause at or above 100% of the budget, whether or not this update is the one that crossed it. */
export function shouldPause(n: BudgetNotification): boolean {
  if ((n.alertThresholdExceeded ?? 0) >= 1) return true;
  return n.budgetAmount > 0 && n.costAmount >= n.budgetAmount;
}

/** The control object, read and written with a generation-match precondition (compare-and-swap). */
export interface ControlStore {
  /** null when the object doesn't exist. */
  read(): Promise<{ body: string; generation: string } | null>;
  /** ifGenerationMatch "0" means "only if the object doesn't exist". */
  write(body: string, ifGenerationMatch: string): Promise<"ok" | "conflict">;
}

export type PauseOutcome = "paused" | "already-paused" | "under-budget" | "other-budget";

export interface PauseOptions {
  /** Ignore notifications for any other budget that might publish to the same topic. */
  expectedBudgetName: string;
  now: Date;
  maxAttempts?: number;
}

export async function applyBudgetNotification(
  store: ControlStore,
  n: BudgetNotification,
  opts: PauseOptions,
): Promise<PauseOutcome> {
  if (n.budgetDisplayName !== opts.expectedBudgetName) return "other-budget";
  if (!shouldPause(n)) return "under-budget";

  const maxAttempts = opts.maxAttempts ?? 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await store.read();
    let state: Record<string, unknown> = {};
    if (current) {
      try {
        const parsed: unknown = JSON.parse(current.body);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          state = parsed as Record<string, unknown>;
        } else {
          state = { previousStateUnparseable: true };
        }
      } catch {
        // Fail closed: an unreadable state still gets paused. The bucket is versioned, so nothing is lost.
        state = { previousStateUnparseable: true };
      }
    }
    if (state.paused === true) return "already-paused";

    const next = {
      ...state,
      paused: true,
      pausedBy: "gcp-budget",
      pausedAt: opts.now.toISOString(),
      pausedReason: `GCP spend ${n.costAmount} of ${n.budgetAmount} ${n.currencyCode ?? ""}`.trim(),
    };
    const result = await store.write(`${JSON.stringify(next, null, 2)}\n`, current ? current.generation : "0");
    if (result === "ok") return "paused";
  }
  throw new Error(`control state changed concurrently ${maxAttempts} times; giving up so the event is retried`);
}
