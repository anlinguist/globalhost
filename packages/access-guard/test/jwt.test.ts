import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwksCache } from "../src/jwks.js";
import { CLOCK_SKEW_SECONDS, verifyAccessJwt, type VerifyResult } from "../src/jwt.js";
import {
  AUD,
  ISSUER,
  NOW,
  OTHER_AUD,
  claims,
  close,
  makeKey,
  sign,
  signHs256WithPublicKey,
  startJwks,
  unsigned,
  type JwksServer,
} from "./helpers.js";

const key = makeKey("k1");
const attacker = makeKey("k1"); // same kid, different key pair
const notPublished = makeKey("k-unpublished");
let jwks: JwksServer;
let keys: JwksCache;

beforeAll(async () => {
  jwks = await startJwks([key.jwk]);
  keys = new JwksCache({ url: jwks.url, minRefreshIntervalMs: 0 });
});
afterAll(() => close(jwks.server));

function check(token: string | undefined, now = NOW): Promise<VerifyResult> {
  return verifyAccessJwt(token, { issuer: ISSUER, audiences: [AUD], keys, now: () => now });
}

const reason = async (token: string | undefined, now?: number) => {
  const r = await check(token, now);
  return r.ok ? "ok" : r.reason;
};

describe("verifyAccessJwt: accepts", () => {
  it("a valid RS256 token from a published key", async () => {
    const r = await check(sign(key));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.email).toBe("owner@example.com");
  });

  it("aud as a string, and any match among several configured audiences", async () => {
    expect(await reason(sign(key, claims({ aud: AUD })))).toBe("ok");
    const r = await verifyAccessJwt(sign(key, claims({ aud: ["x", OTHER_AUD] })), {
      issuer: ISSUER,
      audiences: [AUD, OTHER_AUD],
      keys,
      now: () => NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("times within the clock skew", async () => {
    const exp = NOW + 100;
    expect(await reason(sign(key, claims({ exp })), exp + CLOCK_SKEW_SECONDS - 1)).toBe("ok");
    expect(await reason(sign(key, claims({ nbf: NOW + 30, iat: NOW + 30 })))).toBe("ok");
  });
});

describe("verifyAccessJwt: rejects (adversarial)", () => {
  it("missing or empty token", async () => {
    expect(await reason(undefined)).toBe("missing_token");
    expect(await reason("")).toBe("missing_token");
  });

  it("malformed tokens", async () => {
    for (const t of ["abc", "a.b", "a.b.c.d", "a..c", "a.b.", "!!.??.**", "a b.c.d", `${sign(key)}=`, "eyJ.eyJ.e+/"]) {
      expect(await reason(t), t).toBe("malformed");
    }
  });

  it("non-canonical base64url (stray trailing bits) even if it decodes to a valid signature", async () => {
    const t = sign(key);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(t.at(-1)!);
    // A 256-byte signature leaves 4 unused bits in the last character.
    const forged = t.slice(0, -1) + alphabet[last | 1]!;
    expect(Buffer.from(forged.split(".")[2]!, "base64url")).toEqual(Buffer.from(t.split(".")[2]!, "base64url"));
    expect(await reason(forged)).toBe("malformed");
  });

  it("header that isn't a JSON object", async () => {
    const t = sign(key).split(".");
    expect(await reason([Buffer.from("[1]").toString("base64url"), t[1], t[2]].join("."))).toBe("bad_header");
    expect(await reason(["bm90anNvbg", t[1], t[2]].join("."))).toBe("bad_header");
  });

  it("a signature from a different key with the same kid", async () => {
    expect(await reason(sign(attacker))).toBe("bad_signature");
  });

  it("a payload swapped after signing", async () => {
    const [h, , s] = sign(key).split(".");
    const p = Buffer.from(JSON.stringify(claims({ email: "attacker@example.com" }))).toString("base64url");
    expect(await reason(`${h}.${p}.${s}`)).toBe("bad_signature");
  });

  it("a kid that isn't in the JWKS", async () => {
    expect(await reason(sign(notPublished))).toBe("unknown_kid");
  });

  it("missing kid", async () => {
    expect(await reason(sign(key, claims(), { kid: undefined }))).toBe("missing_kid");
    expect(await reason(sign(key, claims(), { kid: "" }))).toBe("missing_kid");
    expect(await reason(sign(key, claims(), { kid: 1 }))).toBe("missing_kid");
  });

  it("alg none, with or without a signature", async () => {
    expect(await reason(unsigned(key))).toBe("malformed"); // empty signature segment
    expect(await reason(`${unsigned(key)}AAAA`)).toBe("unsupported_alg");
  });

  it("HS256 signed with the RSA public key bytes (alg confusion)", async () => {
    expect(await reason(signHs256WithPublicKey(key))).toBe("unsupported_alg");
  });

  it("any alg other than RS256, even with a valid RSA signature", async () => {
    for (const alg of ["RS512", "PS256", "ES256", "rs256", "RS256 ", ["RS256"], null]) {
      expect(await reason(sign(key, claims(), { alg })), String(alg)).toBe("unsupported_alg");
    }
  });

  it("crit header extensions", async () => {
    expect(await reason(sign(key, claims(), { crit: ["exp"] }))).toBe("bad_header");
  });

  it("wrong issuer", async () => {
    for (const iss of ["https://evil.cloudflareaccess.com", `${ISSUER}/`, "test-team.cloudflareaccess.com", undefined, [ISSUER]]) {
      expect(await reason(sign(key, claims({ iss }))), String(iss)).toBe("bad_issuer");
    }
  });

  it("wrong or missing audience", async () => {
    for (const aud of [OTHER_AUD, [OTHER_AUD], [], undefined, AUD.toUpperCase(), [[AUD]], { 0: AUD }]) {
      expect(await reason(sign(key, claims({ aud }))), JSON.stringify(aud)).toBe("bad_audience");
    }
  });

  it("expired beyond the skew", async () => {
    const exp = NOW - CLOCK_SKEW_SECONDS - 1;
    expect(await reason(sign(key, claims({ exp, iat: exp - 100, nbf: exp - 100 })))).toBe("expired");
  });

  it("missing or non-numeric exp", async () => {
    expect(await reason(sign(key, claims({ exp: undefined })))).toBe("bad_payload");
    expect(await reason(sign(key, claims({ exp: "9999999999" })))).toBe("bad_payload");
  });

  it("nbf in the future", async () => {
    expect(await reason(sign(key, claims({ nbf: NOW + CLOCK_SKEW_SECONDS + 5 })))).toBe("not_yet_valid");
    expect(await reason(sign(key, claims({ nbf: "0" })))).toBe("bad_payload");
  });

  it("iat in the future", async () => {
    expect(await reason(sign(key, claims({ iat: NOW + CLOCK_SKEW_SECONDS + 5 })))).toBe("issued_in_future");
  });

  it("a payload that isn't a JSON object", async () => {
    const input = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url")}.${Buffer.from("[]").toString("base64url")}`;
    const { createSign } = await import("node:crypto");
    const sig = createSign("RSA-SHA256").update(input).sign(key.privateKey).toString("base64url");
    expect(await reason(`${input}.${sig}`)).toBe("bad_payload");
  });

  it("an oversize token, before any parsing or key fetch", async () => {
    const before = jwks.hits;
    const big = sign(key, claims({ pad: "x".repeat(9000) }));
    expect(await reason(big)).toBe("token_too_large");
    expect(jwks.hits).toBe(before);
  });
});
