import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const AUD = "f".repeat(64);
const base = { UPSTREAM_PORT: "3000", ACCESS_TEAM_DOMAIN: "broken-haze-4579.cloudflareaccess.com", ACCESS_AUD: AUD };

describe("loadConfig", () => {
  it("derives issuer and JWKS URL and applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      port: 8080,
      upstreamPort: 3000,
      teamDomain: "broken-haze-4579.cloudflareaccess.com",
      issuer: "https://broken-haze-4579.cloudflareaccess.com",
      audiences: [AUD],
      jwksUrl: "https://broken-haze-4579.cloudflareaccess.com/cdn-cgi/access/certs",
      healthPath: "/__guard/healthz",
    });
  });

  it("accepts several audiences and a custom port and health path", () => {
    const other = "0".repeat(64);
    const c = loadConfig({ ...base, PORT: "9090", ACCESS_AUD: ` ${AUD} , ${other},,${AUD}`, HEALTH_PATH: "/_health/live" });
    expect(c.port).toBe(9090);
    expect(c.audiences).toEqual([AUD, other]);
    expect(c.healthPath).toBe("/_health/live");
  });

  const bad: [string, Record<string, string | undefined>][] = [
    ["missing UPSTREAM_PORT", { ...base, UPSTREAM_PORT: undefined }],
    ["non-numeric port", { ...base, UPSTREAM_PORT: "3000abc" }],
    ["port out of range", { ...base, PORT: "70000" }],
    ["port zero", { ...base, PORT: "0" }],
    ["same ports", { ...base, PORT: "3000" }],
    ["missing team domain", { ...base, ACCESS_TEAM_DOMAIN: undefined }],
    ["team domain with scheme", { ...base, ACCESS_TEAM_DOMAIN: "https://broken-haze-4579.cloudflareaccess.com" }],
    ["team domain with path", { ...base, ACCESS_TEAM_DOMAIN: "broken-haze-4579.cloudflareaccess.com/" }],
    ["team domain elsewhere", { ...base, ACCESS_TEAM_DOMAIN: "evil.example.com" }],
    ["lookalike team domain", { ...base, ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com.evil.com" }],
    ["missing aud", { ...base, ACCESS_AUD: undefined }],
    ["blank aud", { ...base, ACCESS_AUD: " , " }],
    ["short aud", { ...base, ACCESS_AUD: "abc" }],
    ["health path relative", { ...base, HEALTH_PATH: "healthz" }],
    ["health path root", { ...base, HEALTH_PATH: "/" }],
    ["health path dot segment", { ...base, HEALTH_PATH: "/a/../b" }],
    ["health path query", { ...base, HEALTH_PATH: "/h?x=1" }],
    ["health path encoded", { ...base, HEALTH_PATH: "/h%2Fx" }],
  ];
  for (const [name, env] of bad) {
    it(`fails closed: ${name}`, () => {
      expect(() => loadConfig(env)).toThrow(ConfigError);
    });
  }
});
