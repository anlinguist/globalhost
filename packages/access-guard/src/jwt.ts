/**
 * Verify a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`).
 *
 * Deliberately narrow: compact JWS, `alg` exactly `RS256`, a `kid` that names a key
 * from the team's JWKS, no `crit` extensions. The algorithm is never taken from the
 * token to choose a verifier, so `none` and HS* (including HMAC keyed with the RSA
 * public key) can't get through.
 */
import { verify as verifySignature } from "node:crypto";
import type { KeySource } from "./jwks.js";

export const MAX_TOKEN_LENGTH = 8 * 1024;
export const CLOCK_SKEW_SECONDS = 60;

export type RejectReason =
  | "missing_token"
  | "multiple_tokens"
  | "token_too_large"
  | "malformed"
  | "bad_header"
  | "unsupported_alg"
  | "missing_kid"
  | "unknown_kid"
  | "jwks_unavailable"
  | "bad_signature"
  | "bad_payload"
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "not_yet_valid"
  | "issued_in_future";

export type VerifyResult = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: RejectReason };

export interface VerifyOptions {
  issuer: string;
  audiences: readonly string[];
  keys: KeySource;
  /** Seconds since epoch. */
  now?: () => number;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function verifyAccessJwt(token: string | undefined, opts: VerifyOptions): Promise<VerifyResult> {
  if (token === undefined || token === "") return { ok: false, reason: "missing_token" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "token_too_large" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  if (!B64URL.test(h) || !B64URL.test(p) || !B64URL.test(s)) return { ok: false, reason: "malformed" };

  const header = decodeJson(h);
  if (!header) return { ok: false, reason: "bad_header" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (header.crit !== undefined) return { ok: false, reason: "bad_header" };
  if (typeof header.kid !== "string" || header.kid === "") return { ok: false, reason: "missing_kid" };

  const lookup = await opts.keys.getKey(header.kid);
  if (!lookup.ok) return { ok: false, reason: lookup.reason };

  const signingInput = Buffer.from(`${h}.${p}`, "ascii");
  const signature = Buffer.from(s, "base64url");
  let valid: boolean;
  try {
    valid = verifySignature("RSA-SHA256", signingInput, lookup.key, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const claims = decodeJson(p);
  if (!claims) return { ok: false, reason: "bad_payload" };

  if (claims.iss !== opts.issuer) return { ok: false, reason: "bad_issuer" };

  const aud = claims.aud;
  const auds = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string") : [];
  if (!auds.some((a) => opts.audiences.includes(a))) return { ok: false, reason: "bad_audience" };

  const now = (opts.now ?? (() => Date.now() / 1000))();
  if (!isTime(claims.exp)) return { ok: false, reason: "bad_payload" };
  if (now >= claims.exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (claims.nbf !== undefined) {
    if (!isTime(claims.nbf)) return { ok: false, reason: "bad_payload" };
    if (now < claims.nbf - CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
  }
  if (claims.iat !== undefined) {
    if (!isTime(claims.iat)) return { ok: false, reason: "bad_payload" };
    if (claims.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "issued_in_future" };
  }

  return { ok: true, claims };
}
