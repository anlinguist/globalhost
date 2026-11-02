import { afterEach, describe, expect, it } from "vitest";
import { JwksCache, parseJwks } from "../src/jwks.js";
import { close, makeKey, startJwks, type JwksServer } from "./helpers.js";

const k1 = makeKey("k1");
const k2 = makeKey("k2");

let servers: JwksServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => close(s.server)));
  servers = [];
});

async function setup(opts: { ttlMs?: number; minRefreshIntervalMs?: number } = {}) {
  const s = await startJwks([k1.jwk]);
  servers.push(s);
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const cache = new JwksCache({ url: s.url, now: () => t, ...opts });
  return { s, cache, clock };
}

describe("JwksCache", () => {
  it("fetches once and serves known kids from cache within the TTL", async () => {
    const { s, cache, clock } = await setup();
    expect((await cache.getKey("k1")).ok).toBe(true);
    clock.advance(9 * 60_000);
    expect((await cache.getKey("k1")).ok).toBe(true);
    expect(s.hits).toBe(1);
  });

  it("refetches after the TTL", async () => {
    const { s, cache, clock } = await setup();
    await cache.getKey("k1");
    clock.advance(10 * 60_000);
    expect((await cache.getKey("k1")).ok).toBe(true);
    expect(s.hits).toBe(2);
  });

  it("picks up a rotated key on unknown kid", async () => {
    const { s, cache, clock } = await setup();
    await cache.getKey("k1");
    s.state.keys = [k1.jwk, k2.jwk];
    clock.advance(31_000);
    expect((await cache.getKey("k2")).ok).toBe(true);
    expect(s.hits).toBe(2);
  });

  it("rate-limits refetches for a flood of bogus kids", async () => {
    const { s, cache, clock } = await setup();
    await cache.getKey("k1");
    clock.advance(31_000);
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => cache.getKey(`bogus-${i}`)));
    expect(results.every((r) => !r.ok && r.reason === "unknown_kid")).toBe(true);
    for (let i = 0; i < 50; i++) await cache.getKey(`more-${i}`);
    expect(s.hits).toBe(2); // the initial fetch + one refetch, shared by all
    expect((await cache.getKey("k1")).ok).toBe(true); // real kid still served
  });

  it("coalesces concurrent first fetches", async () => {
    const { s, cache } = await setup();
    await Promise.all(Array.from({ length: 20 }, () => cache.getKey("k1")));
    expect(s.hits).toBe(1);
  });

  it("fails closed when the first fetch fails", async () => {
    const { s, cache } = await setup();
    s.state.status = 500;
    expect(await cache.getKey("k1")).toEqual({ ok: false, reason: "jwks_unavailable" });
  });

  it("fails closed when the endpoint is unreachable", async () => {
    const cache = new JwksCache({ url: "http://127.0.0.1:1/certs", timeoutMs: 1000 });
    expect(await cache.getKey("k1")).toEqual({ ok: false, reason: "jwks_unavailable" });
  });

  it("does not use stale keys after the TTL if the refetch fails", async () => {
    const { s, cache, clock } = await setup();
    expect((await cache.getKey("k1")).ok).toBe(true);
    s.state.status = 503;
    clock.advance(11 * 60_000);
    expect(await cache.getKey("k1")).toEqual({ ok: false, reason: "jwks_unavailable" });
  });

  it("keeps fresh keys when an unknown-kid refetch fails", async () => {
    const { s, cache, clock } = await setup();
    await cache.getKey("k1");
    s.state.body = "not json";
    clock.advance(31_000);
    expect(await cache.getKey("k2")).toEqual({ ok: false, reason: "unknown_kid" });
    expect((await cache.getKey("k1")).ok).toBe(true);
  });

  it("fails closed on oversize or malformed JWKS documents", async () => {
    const { s, cache } = await setup();
    s.state.body = JSON.stringify({ keys: [k1.jwk], pad: "x".repeat(300 * 1024) });
    expect(await cache.getKey("k1")).toEqual({ ok: false, reason: "jwks_unavailable" });
  });
});

describe("parseJwks", () => {
  it("imports RSA signing keys", () => {
    expect([...parseJwks(JSON.stringify({ keys: [k1.jwk, k2.jwk] })).keys()]).toEqual(["k1", "k2"]);
  });

  it("skips keys that aren't 2048+ bit RS256 signing keys", () => {
    const weak = makeKey("weak", 1024);
    const keys = parseJwks(
      JSON.stringify({
        keys: [
          weak.jwk,
          { ...k2.jwk, alg: "RS512" },
          { ...k2.jwk, use: "enc" },
          { kty: "oct", kid: "hmac", k: "c2VjcmV0" },
          { ...k2.jwk, kid: "" },
          "junk",
          k1.jwk,
        ],
      }),
    );
    expect([...keys.keys()]).toEqual(["k1"]);
  });

  it("throws when nothing usable is left", () => {
    expect(() => parseJwks("{}")).toThrow();
    expect(() => parseJwks(JSON.stringify({ keys: [] }))).toThrow();
    expect(() => parseJwks("nope")).toThrow();
  });
});
