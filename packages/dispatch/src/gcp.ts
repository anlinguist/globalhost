// GCP access for the dispatcher, as sa:globalhost-gh-dispatch through WIF (P1-04): the control bucket
// (kill switch, daily spend, builder slots), the runs bucket (archived outputs) and the App key secret.
// All control writes are compare-and-swap on the object generation, so concurrent runs can't race.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
