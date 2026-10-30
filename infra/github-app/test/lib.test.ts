import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_PERMISSIONS,
  ConversionSchema,
  FORBIDDEN_PERMISSIONS,
  TOKEN_PERMISSIONS,
  appJwt,
  buildManifest,
  isValidManifestCode,
  parseRepo,
  renderStartPage,
} from "../src/lib.ts";

describe("manifest", () => {
  const manifest = buildManifest("http://127.0.0.1:8765/callback");

  it("requests exactly the ARCHITECTURE §5.1 permissions", () => {
    expect(manifest.default_permissions).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "read",
      actions: "read",
      metadata: "read",
    });
  });

  it("requests no workflow, admin, secret or member permission", () => {
    for (const p of FORBIDDEN_PERMISSIONS) expect(manifest.default_permissions).not.toHaveProperty(p);
  });

  it("is private, named globalhost-ai, with an inactive webhook and no events", () => {
    expect(manifest).toMatchObject({ name: "globalhost-ai", public: false, default_events: [] });
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.redirect_url).toBe("http://127.0.0.1:8765/callback");
  });

  it("token subsets never exceed what the App holds", () => {
    const rank = { read: 1, write: 2 } as const;
    for (const subset of Object.values(TOKEN_PERMISSIONS)) {
      for (const [k, v] of Object.entries(subset)) {
        const held = APP_PERMISSIONS[k as keyof typeof APP_PERMISSIONS];
        expect(rank[v]).toBeLessThanOrEqual(rank[held]);
      }
    }
    expect(Object.values(TOKEN_PERMISSIONS.read)).toEqual(["read", "read", "read"]);
  });
});

describe("start page", () => {
  it("posts the manifest to github.com with the state, HTML-escaped", () => {
    const m = buildManifest("http://127.0.0.1:8765/callback");
    m.description = `"><script>alert(1)</script>`;
    const html = renderStartPage(m, "abc123");
    expect(html).toContain('action="https://github.com/settings/apps/new?state=abc123"');
    expect(html).not.toContain("<script>");
    const value = /name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "";
    const decoded = value.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
    expect(JSON.parse(decoded)).toEqual(m);
  });
});

describe("input checks", () => {
  it.each([
    ["abc123def456", true],
    ["../../user", false],
    ["abc?x=1", false],
    ["", false],
    [null, false],
  ])("manifest code %j valid=%s", (code, ok) => {
    expect(isValidManifestCode(code)).toBe(ok);
  });

  it.each(["anlinguist/numu-know", "a/b.c_d-e"])("parses repo %s", (r) => {
    expect(() => parseRepo(r)).not.toThrow();
  });
  it.each(["numu-know", "a/b/c", "a/../b?x", "a/b c"])("rejects repo %s", (r) => {
    expect(() => parseRepo(r)).toThrow();
  });

  it("rejects a conversion response without a private key", () => {
    expect(() =>
      ConversionSchema.parse({ id: 1, slug: "globalhost-ai", html_url: "https://github.com/apps/globalhost-ai", pem: "x" }),
    ).toThrow();
  });
});

describe("appJwt", () => {
  it("signs an RS256 JWT GitHub accepts: iss = app id, ≤10 min, backdated iat", () => {
    // Throwaway key generated per test run; no key material is committed.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = appJwt("12345", pem, 1_800_000_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(payload).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});
