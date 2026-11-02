/**
 * Cloudflare Access signing keys, fetched from `https://<team>/cdn-cgi/access/certs`.
 *
 * - Cached for `ttlMs`; after that, keys are refetched before use. If the refetch
 *   fails, the stale keys are NOT used: verification fails closed.
 * - An unknown `kid` triggers a refetch (key rotation), but at most once per
 *   `minRefreshIntervalMs`, and concurrent callers share one in-flight fetch, so a
 *   flood of tokens with made-up kids can't hammer the endpoint.
 * - Only RSA signing keys of at least 2048 bits are imported.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { silentLogger, type Logger } from "./log.js";

export type KeyLookup = { ok: true; key: KeyObject } | { ok: false; reason: "jwks_unavailable" | "unknown_kid" };

export interface KeySource {
  getKey(kid: string): Promise<KeyLookup>;
}

export interface JwksCacheOptions {
  url: string;
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  minRefreshIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: Logger;
}

const MAX_JWKS_BYTES = 256 * 1024;
const MAX_KEYS = 32;
const MIN_RSA_BITS = 2048;

export class JwksCache implements KeySource {
  readonly #url: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #ttlMs: number;
  readonly #minRefreshIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #log: Logger;

  #keys = new Map<string, KeyObject>();
  #fetchedAt: number | undefined;
  #lastAttempt: number | undefined;
  #inflight: Promise<void> | undefined;

  constructor(opts: JwksCacheOptions) {
    this.#url = opts.url;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.#minRefreshIntervalMs = opts.minRefreshIntervalMs ?? 30_000;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? silentLogger;
  }

  #fresh(): boolean {
    return this.#fetchedAt !== undefined && this.#now() - this.#fetchedAt < this.#ttlMs;
  }

  async getKey(kid: string): Promise<KeyLookup> {
    if (this.#fresh()) {
      const key = this.#keys.get(kid);
      if (key) return { ok: true, key };
    }
    await this.#maybeRefresh();
    if (!this.#fresh()) return { ok: false, reason: "jwks_unavailable" };
    const key = this.#keys.get(kid);
    return key ? { ok: true, key } : { ok: false, reason: "unknown_kid" };
  }

  /** Fetch now unless a fetch is in flight (join it) or one was attempted too recently. */
  async #maybeRefresh(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    const now = this.#now();
    if (this.#lastAttempt !== undefined && now - this.#lastAttempt < this.#minRefreshIntervalMs) return;
    this.#lastAttempt = now;
    this.#inflight = this.#refresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<void> {
    try {
      const res = await this.#fetch(this.#url, {
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new JwksError(`status_${res.status}`);
      const body = await readCapped(res, MAX_JWKS_BYTES);
      const keys = parseJwks(body);
      this.#keys = keys;
      this.#fetchedAt = this.#now();
      this.#log("INFO", "jwks refreshed", { keys: keys.size });
    } catch (err) {
      const reason = err instanceof JwksError ? err.message : err instanceof Error ? err.name : "unknown";
      this.#log("WARNING", "jwks fetch failed", { reason });
    }
  }
}

class JwksError extends Error {}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) throw new JwksError("empty_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) throw new JwksError("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Exported for tests. Throws JwksError if no usable key is present. */
export function parseJwks(text: string): Map<string, KeyObject> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new JwksError("bad_json");
  }
  if (!isRecord(doc) || !Array.isArray(doc.keys)) throw new JwksError("no_keys");
  const out = new Map<string, KeyObject>();
  for (const jwk of doc.keys.slice(0, MAX_KEYS)) {
    if (!isRecord(jwk)) continue;
    const { kty, kid, alg, use, n, e } = jwk;
    if (kty !== "RSA" || typeof kid !== "string" || kid === "" || kid.length > 256) continue;
    if (alg !== undefined && alg !== "RS256") continue;
    if (use !== undefined && use !== "sig") continue;
    if (typeof n !== "string" || typeof e !== "string") continue;
    try {
      const key = createPublicKey({ key: { kty: "RSA", n, e }, format: "jwk" });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) continue;
      out.set(kid, key);
    } catch {
      continue;
    }
  }
  if (out.size === 0) throw new JwksError("no_usable_keys");
  return out;
}
