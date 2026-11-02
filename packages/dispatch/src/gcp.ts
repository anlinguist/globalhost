// GCP access for the dispatcher, as sa:globalhost-gh-dispatch through WIF (P1-04): the control bucket
// (kill switch, daily spend, builder slots, review claims, the per-PR review ledger), the runs bucket (archived
// outputs) and the App key secret.
// All control writes are compare-and-swap on the object generation, so concurrent runs can't race.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addUsd,
  MAX_LEDGER_RUNS,
  ReviewClaimSchema,
  ReviewLedgerSchema,
  ShadowEntrySchema,
  type ReviewClaim,
  type ReviewLedger,
  type ShadowEntry,
} from "@globalhost/core";

const exec = promisify(execFile);

export const CONTROL_BUCKET = "globalhost-control";
export const RUNS_BUCKET = "globalhost-runs";
export const FACTORY_PROJECT = "globalhost-factory";

export type AccessToken = () => Promise<string>;

/** After google-github-actions/auth, gcloud holds the WIF credential; tokens are minted per call. */
export const gcloudAccessToken: AccessToken = async () => (await exec("gcloud", ["auth", "print-access-token"])).stdout.trim();

interface Obj {
  body: string;
  generation: string;
}

export class ObjectStore {
  constructor(
    private readonly token: AccessToken,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${await this.token()}`, ...extra };
  }

  async read(bucket: string, name: string): Promise<Obj | null> {
    const base = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
    const meta = await this.fetchImpl(base, { headers: await this.headers() });
    if (meta.status === 404) return null;
    if (!meta.ok) throw new Error(`GCS read gs://${bucket}/${name}: HTTP ${meta.status}`);
    const { generation } = (await meta.json()) as { generation: string };
    const data = await this.fetchImpl(`${base}?alt=media&generation=${generation}`, { headers: await this.headers() });
    if (data.status === 404) return null; // replaced between the two calls; callers retry
    if (!data.ok) throw new Error(`GCS read gs://${bucket}/${name}: HTTP ${data.status}`);
    return { body: await data.text(), generation };
  }

  /** ifGenerationMatch "0" = create only; returns "conflict" when the precondition fails. */
  async write(bucket: string, name: string, body: string | Uint8Array, ifGenerationMatch?: string, contentType = "application/json"): Promise<"ok" | "conflict"> {
    const params = new URLSearchParams({ uploadType: "media", name });
    if (ifGenerationMatch !== undefined) params.set("ifGenerationMatch", ifGenerationMatch);
    const resp = await this.fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?${params}`, {
      method: "POST",
      headers: await this.headers({ "content-type": contentType }),
      body,
    });
    if (resp.status === 412) return "conflict";
    if (!resp.ok) throw new Error(`GCS write gs://${bucket}/${name}: HTTP ${resp.status}`);
    return "ok";
  }

  async remove(bucket: string, name: string, ifGenerationMatch: string): Promise<"ok" | "conflict"> {
    const resp = await this.fetchImpl(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?ifGenerationMatch=${ifGenerationMatch}`,
      { method: "DELETE", headers: await this.headers() },
    );
    if (resp.status === 412 || resp.status === 404) return "conflict";
    if (!resp.ok) throw new Error(`GCS delete gs://${bucket}/${name}: HTTP ${resp.status}`);
    return "ok";
  }
}

const repoKey = (repo: string) => repo.replace("/", "__");
const MAX_CAS_ATTEMPTS = 8;

// GitHub's owner and repo name rules, checked before either goes into an object name.
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;

/** A PR, as review objects key it. */
export interface ReviewPr {
  /** `owner/name`. Lowercased in object names: GitHub names are case-insensitive, so one PR has one budget. */
  repo: string;
  pr: number;
}
export interface ReviewHead extends ReviewPr {
  /** The PR head commit, 40 lowercase hex. */
  sha: string;
}

function reviewPrKey(repo: unknown, pr: unknown): string {
  if (typeof repo !== "string" || !REPO_SLUG.test(repo) || repo.endsWith("/.") || repo.includes("..")) {
    throw new Error("review: repo must be an owner/name slug");
  }
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("review: pr must be a positive integer");
  return `reviews/${repo.toLowerCase()}/pr-${pr}`;
}

/** `reviews/<repo>/pr-<n>.json` in the control bucket: the PR's review ledger and shadow index. */
export function reviewLedgerObject({ repo, pr }: ReviewPr): string {
  return `${reviewPrKey(repo, pr)}.json`;
}

/** `reviews/<repo>/pr-<n>/<sha>.claim.json` in the control bucket: one review per head SHA. */
export function reviewClaimObject({ repo, pr, sha }: ReviewHead): string {
  const key = reviewPrKey(repo, pr);
  if (typeof sha !== "string" || !HEAD_SHA.test(sha)) throw new Error("review: sha must be 40 lowercase hex characters");
  return `${key}/${sha}.claim.json`;
}

export type ReviewClaimResult = { claimed: true; claim: ReviewClaim } | { claimed: false; existing: ReviewClaim | null };

function parseLedger(name: string, body: string): ReviewLedger {
  try {
    return ReviewLedgerSchema.parse(JSON.parse(body));
  } catch {
    throw new Error(`gs://${CONTROL_BUCKET}/${name} is not a valid review ledger; fix it by hand`);
  }
}

export class ControlPlane {
  constructor(
    private readonly store: ObjectStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The kill switch. Unreadable or corrupt state fails closed. */
  async paused(): Promise<boolean> {
    const obj = await this.store.read(CONTROL_BUCKET, "state.json");
    if (!obj) return false;
    try {
      const state = JSON.parse(obj.body) as { paused?: unknown };
      // Anything but an explicit false (or no flag) counts as paused.
      return state.paused !== undefined && state.paused !== false;
    } catch {
      return true;
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.update("state.json", (cur) => ({ ...cur, paused, updatedAt: this.now().toISOString() }));
  }

  private spendObject(repo: string) {
    return `spend/${this.now().toISOString().slice(0, 10)}/${repoKey(repo)}.json`;
  }

  async spentTodayUsd(repo: string): Promise<number> {
    const obj = await this.store.read(CONTROL_BUCKET, this.spendObject(repo));
    if (!obj) return 0;
    const usd = (JSON.parse(obj.body) as { usd?: unknown }).usd;
    return typeof usd === "number" ? usd : Number.POSITIVE_INFINITY; // corrupt → over budget
  }

  /** Adds a run's cost to today's total. A resumed session's cost is cumulative, so pass the delta. */
  async recordSpend(repo: string, runId: string, usd: number): Promise<void> {
    await this.update(this.spendObject(repo), (cur) => ({
      usd: Math.round(((typeof cur.usd === "number" ? cur.usd : 0) + usd) * 100) / 100,
      runs: [...(Array.isArray(cur.runs) ? cur.runs : []), { runId, usd }].slice(-200),
    }));
  }

  /**
   * Takes one of `slots` builder slots for the repo (limits.maxConcurrentBuilders). A slot older than
   * `staleMinutes` is assumed abandoned (a crashed job) and taken over. Returns the slot or null if busy.
   */
  async acquireSlot(repo: string, runId: string, slots: number, staleMinutes: number): Promise<string | null> {
    for (let i = 0; i < slots; i++) {
      const name = `locks/${repoKey(repo)}/builder-${i}.json`;
      const body = JSON.stringify({ runId, takenAt: this.now().toISOString() });
      if ((await this.store.write(CONTROL_BUCKET, name, body, "0")) === "ok") return name;
      const held = await this.store.read(CONTROL_BUCKET, name);
      if (!held) continue;
      const takenAt = Date.parse((JSON.parse(held.body) as { takenAt?: string }).takenAt ?? "");
      if (!(this.now().getTime() - takenAt > staleMinutes * 60_000)) continue;
      if ((await this.store.write(CONTROL_BUCKET, name, body, held.generation)) === "ok") return name;
    }
    return null;
  }

  async releaseSlot(slot: string, runId: string): Promise<void> {
    const held = await this.store.read(CONTROL_BUCKET, slot);
    if (!held || (JSON.parse(held.body) as { runId?: string }).runId !== runId) return;
    await this.store.remove(CONTROL_BUCKET, slot, held.generation);
  }

  /**
   * Claims the review of one head SHA (create-only), so one review runs per SHA. If another run holds it, fails
   * unless that claim never completed and is older than `staleMinutes` (a crashed run, e.g. perRunMinutes + 30),
   * in which case it is taken over by compare-and-swap. A claim that doesn't parse is never taken over:
   * `existing` is null and a human clears it.
   */
  async reviewClaim(head: ReviewHead, runId: string, staleMinutes: number): Promise<ReviewClaimResult> {
    const name = reviewClaimObject(head);
    const fresh = (previousRunId: string | null): ReviewClaim =>
      ReviewClaimSchema.parse({
        version: 1,
        sha: head.sha,
        runId,
        claimedAt: this.now().toISOString(),
        previousRunId,
        completedAt: null,
        recordPath: null,
      });
    const claim = fresh(null);
    if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(claim), "0")) === "ok") return { claimed: true, claim };

    const held = await this.readClaim(name);
    if (!held) return { claimed: false, existing: null };
    const { claim: existing, generation } = held;
    const age = this.now().getTime() - Date.parse(existing.claimedAt);
    if (existing.recordPath !== null || !(age > staleMinutes * 60_000)) return { claimed: false, existing };
    const takeover = fresh(existing.runId);
    if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(takeover), generation)) === "ok") {
      return { claimed: true, claim: takeover };
    }
    return { claimed: false, existing: (await this.readClaim(name))?.claim ?? null };
  }

  /**
   * Marks the holder's claim completed, pointing at the archived review record. Returns false if `runId` doesn't
   * hold the claim (it was taken over) or the claim already points at a different record.
   */
  async completeReviewClaim(head: ReviewHead, runId: string, recordPath: string): Promise<boolean> {
    const name = reviewClaimObject(head);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const held = await this.readClaim(name);
      if (!held || held.claim.runId !== runId) return false;
      if (held.claim.recordPath !== null) return held.claim.recordPath === recordPath;
      const done = ReviewClaimSchema.parse({ ...held.claim, completedAt: this.now().toISOString(), recordPath });
      if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(done), held.generation)) === "ok") return true;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }

  private async readClaim(name: string): Promise<{ claim: ReviewClaim; generation: string } | null> {
    const obj = await this.store.read(CONTROL_BUCKET, name);
    if (!obj) return null;
    try {
      return { claim: ReviewClaimSchema.parse(JSON.parse(obj.body)), generation: obj.generation };
    } catch {
      return null;
    }
  }

  /** The PR's review spend so far. No ledger is 0; a corrupt one counts as over budget. */
  async prReviewSpend(pr: ReviewPr): Promise<number> {
    const obj = await this.store.read(CONTROL_BUCKET, reviewLedgerObject(pr));
    if (!obj) return 0;
    try {
      return ReviewLedgerSchema.parse(JSON.parse(obj.body)).reviewSpendUsd;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** The PR's ledger and shadow index, or null before its first recorded review. Throws if it is corrupt. */
  async reviewLedger(pr: ReviewPr): Promise<ReviewLedger | null> {
    const name = reviewLedgerObject(pr);
    const obj = await this.store.read(CONTROL_BUCKET, name);
    return obj ? parseLedger(name, obj.body) : null;
  }

  /**
   * Adds a review run's cost to the PR's review spend and appends its shadow entry, by compare-and-swap.
   * Idempotent per runId: recording a run again changes nothing and returns the stored entry. `prSpendUsd` is
   * restamped with the ledger's new total, so concurrent runs can't both claim the same running total.
   */
  async recordReviewRun(pr: ReviewPr, entry: ShadowEntry): Promise<ShadowEntry> {
    const name = reviewLedgerObject(pr);
    const valid = ShadowEntrySchema.parse(entry);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const obj = await this.store.read(CONTROL_BUCKET, name);
      const cur: ReviewLedger = obj ? parseLedger(name, obj.body) : { version: 1, reviewSpendUsd: 0, runs: [] };
      const seen = cur.runs.find((r) => r.runId === valid.runId);
      if (seen) return seen;
      const reviewSpendUsd = addUsd(cur.reviewSpendUsd, valid.costUsd);
      const stored: ShadowEntry = { ...valid, prSpendUsd: reviewSpendUsd };
      const next = ReviewLedgerSchema.parse({ version: 1, reviewSpendUsd, runs: [...cur.runs, stored].slice(-MAX_LEDGER_RUNS) });
      if ((await this.store.write(CONTROL_BUCKET, name, JSON.stringify(next), obj?.generation ?? "0")) === "ok") return stored;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }

  private async update(name: string, change: (cur: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const obj = await this.store.read(CONTROL_BUCKET, name);
      let cur: Record<string, unknown> = {};
      if (obj) {
        try {
          cur = JSON.parse(obj.body) as Record<string, unknown>;
        } catch {
          throw new Error(`gs://${CONTROL_BUCKET}/${name} is not JSON; fix it by hand`);
        }
      }
      const result = await this.store.write(CONTROL_BUCKET, name, JSON.stringify(change(cur)), obj?.generation ?? "0");
      if (result === "ok") return;
    }
    throw new Error(`gs://${CONTROL_BUCKET}/${name}: too many concurrent updates`);
  }
}

/** Reads one secret version's payload into memory (Secret Manager REST). */
export async function accessSecret(token: AccessToken, name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const resp = await fetchImpl(
    `https://secretmanager.googleapis.com/v1/projects/${FACTORY_PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { authorization: `Bearer ${await token()}` } },
  );
  if (!resp.ok) throw new Error(`Secret Manager ${name}: HTTP ${resp.status}`);
  const body = (await resp.json()) as { payload?: { data?: string } };
  if (!body.payload?.data) throw new Error(`Secret Manager ${name}: empty payload`);
  return Buffer.from(body.payload.data, "base64").toString("utf8");
}
