import http, { type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GuardConfig } from "../src/config.js";
import { createGuard, stripAccessCookie, type Guard } from "../src/guard.js";
import { JwksCache } from "../src/jwks.js";
import type { LogFields, Logger } from "../src/log.js";
import { AUD, ISSUER, NOW, TEAM, claims, close, listen, makeKey, sign, startJwks, type JwksServer } from "./helpers.js";

const key = makeKey("k1");
const stranger = makeKey("k1");

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  rawHeaders: string[];
  body: string;
}

let jwks: JwksServer;
let upstream: http.Server;
let upstreamPort: number;
let seen: Seen[];
/** Per-test upstream behavior override. */
let upstreamHandler: ((req: IncomingMessage, res: http.ServerResponse) => void) | undefined;

let guard: Guard;
let guardPort: number;
let logs: { severity: string; message: string; fields?: LogFields }[];

beforeAll(async () => {
  jwks = await startJwks([key.jwk]);
  upstream = http.createServer((req, res) => {
    if (upstreamHandler) return upstreamHandler(req, res);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { "content-type": "text/plain", "x-upstream": "yes", "keep-alive": "timeout=5" });
      res.end("hello from app");
    });
  });
  upstreamPort = await listen(upstream);
});

afterAll(async () => {
  await close(upstream);
  await close(jwks.server);
});

function config(over: Partial<GuardConfig> = {}): GuardConfig {
  return {
    port: 0,
    upstreamPort,
    teamDomain: TEAM,
    issuer: ISSUER,
    audiences: [AUD],
    jwksUrl: jwks.url,
    healthPath: "/__guard/healthz",
    ...over,
  };
}

async function startGuard(cfg: GuardConfig, keys = new JwksCache({ url: cfg.jwksUrl })): Promise<void> {
  const log: Logger = (severity, message, fields) => logs.push({ severity, message, fields });
  guard = createGuard(cfg, { keys, log, now: () => NOW });
  guardPort = await listen(guard.server);
}

beforeEach(async () => {
  seen = [];
  logs = [];
  upstreamHandler = undefined;
  jwks.state.status = 200;
  await startGuard(config());
});

afterEach(async () => {
  await guard.shutdown(0);
});

interface Res {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

function request(path: string, headers: OutgoingHttpHeaders = {}, opts: { method?: string; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: guardPort, path, method: opts.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Raw bytes on a socket, for request lines Node's client would refuse to send. */
function raw(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(guardPort, "127.0.0.1", () => sock.write(text));
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", () => resolve(Buffer.concat(chunks).toString()));
    sock.on("error", reject);
    sock.setTimeout(2000, () => sock.destroy(new Error("timeout")));
  });
}

const auth = (token = sign(key)) => ({ "cf-access-jwt-assertion": token });

describe("guard: authorized requests", () => {
  it("proxies a valid token to the app, preserving method, path, query and body", async () => {
    const res = await request("/api/items?x=1&y=%2F", { ...auth(), "content-type": "application/json" }, { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from app");
    expect(res.headers["x-upstream"]).toBe("yes");
    expect(res.headers["keep-alive"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/items?x=1&y=%2F", body: '{"a":1}' });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("sets X-Forwarded-Host from Host", async () => {
    await request("/", { ...auth(), host: "svc-abc.a.run.app" });
    expect(seen[0]!.headers.host).toBe("svc-abc.a.run.app");
    expect(seen[0]!.headers["x-forwarded-host"]).toBe("svc-abc.a.run.app");
  });

  it("never hands the Access credential to the app, in a header or a cookie", async () => {
    const token = sign(key);
    await request("/", {
      ...auth(token),
      cookie: `a=1; CF_Authorization=${token}; b=2; cf_authorization=${token}`,
      "cf-access-authenticated-user-email": "forged@example.com",
    });
    const up = seen[0]!;
    expect(up.headers["cf-access-jwt-assertion"]).toBeUndefined();
    expect(up.headers["cf-access-authenticated-user-email"]).toBeUndefined();
    expect(up.headers.cookie).toBe("a=1; b=2");
    expect(up.rawHeaders.join("\n")).not.toContain(token.slice(0, 40));
    expect(up.rawHeaders.join("\n")).not.toContain(token.split(".")[2]!);
  });

  it("drops the Cookie header when the Access cookie was the only one", async () => {
    const token = sign(key);
    const res = await raw(
      `GET / HTTP/1.1\r\nHost: x\r\nCf-Access-Jwt-Assertion: ${token}\r\nCookie: CF_Authorization=${token}\r\nCookie: CF_Authorization=${token};\r\nConnection: close\r\n\r\n`,
    );
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.rawHeaders.join("\n")).not.toContain(token.slice(0, 40));
  });

  it("prefers an incoming X-Forwarded-Host and sends exactly one", async () => {
    await request("/", { ...auth(), host: "svc.a.run.app", "x-forwarded-host": "numu-web-pr-3.globalhost.ai" });
    expect(seen[0]!.headers["x-forwarded-host"]).toBe("numu-web-pr-3.globalhost.ai");
    expect(seen[0]!.rawHeaders.filter((h) => h.toLowerCase() === "x-forwarded-host")).toHaveLength(1);
  });

  it("strips X-Globalhost-* and hop-by-hop headers, including ones named in Connection", async () => {
    await request("/", {
      ...auth(),
      "X-Globalhost-User": "admin@example.com",
      "x-globalhost-anything": "1",
      connection: "keep-alive, X-Secret-Hop",
      "x-secret-hop": "1",
      "proxy-authorization": "Basic abc",
      te: "trailers",
      "x-normal": "kept",
    });
    const names = Object.keys(seen[0]!.headers);
    expect(names.filter((n) => n.startsWith("x-globalhost-"))).toEqual([]);
    expect(names).not.toContain("x-secret-hop");
    expect(names).not.toContain("proxy-authorization");
    expect(names).not.toContain("te");
    expect(seen[0]!.headers["x-normal"]).toBe("kept");
  });

  it("streams the response: the first chunk arrives before the app finishes", async () => {
    let finish!: () => void;
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first\n");
      finish = () => res.end("last\n");
    };
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: guardPort, path: "/stream", headers: auth(), agent: false }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
          if (body === "first\n") finish();
        });
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.end();
    });
    expect(got).toBe("first\nlast\n");
  });

  it("streams the request: the app sees the first chunk before the client finishes", async () => {
    let gotFirst!: () => void;
    const firstSeen = new Promise<void>((r) => (gotFirst = r));
    upstreamHandler = (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString();
        if (body === "part1") gotFirst();
      });
      req.on("end", () => res.end(`got:${body}`));
    };
    const res = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: guardPort, path: "/upload", method: "POST", headers: auth(), agent: false }, (r) => {
        let b = "";
        r.on("data", (c: Buffer) => (b += c.toString()));
        r.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.write("part1");
      firstSeen.then(() => req.end("part2"), reject);
    });
    expect(res).toBe("got:part1part2");
  });

  it("returns 502 when the app is unreachable", async () => {
    await guard.shutdown(0);
    await startGuard(config({ upstreamPort: 1 }));
    const res = await request("/", auth());
    expect(res.status).toBe(502);
    expect(logs.some((l) => l.message === "upstream error")).toBe(true);
  });

  it("survives a client abort mid-response and closes the upstream request", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    upstreamHandler = (_req, res) => {
      res.writeHead(200);
      res.write("partial");
      res.on("close", () => upstreamClosed());
    };
    await new Promise<void>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: guardPort, path: "/slow", headers: auth(), agent: false }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.end();
    });
    await closed;
    upstreamHandler = undefined;
    expect((await request("/after", auth())).status).toBe(200);
  });
});

describe("guard: rejected requests never reach the app", () => {
  const cases: [string, OutgoingHttpHeaders, string][] = [
    ["missing header", {}, "missing_token"],
    ["empty header", { "cf-access-jwt-assertion": "" }, "missing_token"],
    ["malformed token", { "cf-access-jwt-assertion": "not.a.jwt!" }, "malformed"],
    ["wrong signature", auth(sign(stranger)), "bad_signature"],
    ["kid not in JWKS", auth(sign(makeKey("other"))), "unknown_kid"],
    ["wrong issuer", auth(sign(key, claims({ iss: "https://evil.cloudflareaccess.com" }))), "bad_issuer"],
    ["wrong audience", auth(sign(key, claims({ aud: ["c".repeat(64)] }))), "bad_audience"],
    ["expired", auth(sign(key, claims({ exp: NOW - 3600 }))), "expired"],
    ["nbf in future", auth(sign(key, claims({ nbf: NOW + 3600 }))), "not_yet_valid"],
    ["oversize token", auth(sign(key, claims({ pad: "x".repeat(9000) }))), "token_too_large"],
    ["token only as CF_Authorization cookie", { cookie: `CF_Authorization=${sign(key)}` }, "missing_token"],
    ["token in Authorization header", { authorization: `Bearer ${sign(key)}` }, "missing_token"],
  ];

  for (const [name, headers, reason] of cases) {
    it(`${name} -> 403 (${reason})`, async () => {
      const res = await request("/secret", headers);
      expect(res.status).toBe(403);
      expect(res.body).toBe("Forbidden\n");
      expect(seen).toHaveLength(0);
      expect(logs.at(-1)).toMatchObject({ severity: "WARNING", message: "request rejected", fields: { reason } });
    });
  }

  it("rejects two token headers", async () => {
    const t = sign(key);
    const res = await raw(`GET / HTTP/1.1\r\nHost: x\r\nCf-Access-Jwt-Assertion: ${t}\r\nCf-Access-Jwt-Assertion: ${t}\r\nConnection: close\r\n\r\n`);
    expect(res).toMatch(/^HTTP\/1\.1 403/);
    expect(seen).toHaveLength(0);
  });

  it("does not echo the token or the reason in the response, nor log the token", async () => {
    const t = sign(key, claims({ aud: "nope" }));
    const res = await request("/", auth(t));
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(t.slice(0, 20));
    expect(res.body).not.toContain("audience");
    expect(JSON.stringify(logs)).not.toContain(t.slice(0, 20));
  });

  it("fails closed when the JWKS can't be fetched", async () => {
    jwks.state.status = 500;
    await guard.shutdown(0);
    await startGuard(config());
    const res = await request("/", auth());
    expect(res.status).toBe(403);
    expect(logs.at(-1)?.fields?.reason).toBe("jwks_unavailable");
    expect(seen).toHaveLength(0);
  });

  it("rejects headers over the size limit with 431", async () => {
    const res = await raw(`GET / HTTP/1.1\r\nHost: x\r\nCf-Access-Jwt-Assertion: ${sign(key)}\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`);
    expect(res).toMatch(/^HTTP\/1\.1 431/);
    expect(seen).toHaveLength(0);
  });

  it("rejects absolute-form request targets even with a valid token", async () => {
    const res = await raw(`GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: x\r\nCf-Access-Jwt-Assertion: ${sign(key)}\r\nConnection: close\r\n\r\n`);
    expect(res).toMatch(/^HTTP\/1\.1 400/);
    expect(seen).toHaveLength(0);
  });

  it("answers WebSocket upgrades with 501, token or not", async () => {
    for (const h of ["", `Cf-Access-Jwt-Assertion: ${sign(key)}\r\n`]) {
      const res = await raw(
        `GET /ws HTTP/1.1\r\nHost: x\r\n${h}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      );
      expect(res).toMatch(/^HTTP\/1\.1 501/);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("guard: health path", () => {
  it("answers 200 without a token and without calling the app", async () => {
    upstreamHandler = () => {
      throw new Error("health must not be proxied");
    };
    for (const path of ["/__guard/healthz", "/__guard/healthz?probe=1", "/__guard/healthz?"]) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      expect(res.body).toBe("ok\n");
    }
    expect((await request("/__guard/healthz", {}, { method: "HEAD" })).status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it("is answered by the guard even with a valid token", async () => {
    const res = await request("/__guard/healthz", auth());
    expect(res.body).toBe("ok\n");
    expect(seen).toHaveLength(0);
  });

  it("near-miss paths need a token like everything else", async () => {
    for (const path of [
      "/__guard/healthz/../x",
      "/__guard/healthz/",
      "/__guard/healthz/x",
      "//__guard/healthz",
      "/__guard/./healthz",
      "/__guard/%68ealthz",
      "/__guard/healthz%2F..%2Fx",
      "/__guard/healthz%3Fx",
      "/__guard/healthz;x",
      "/__GUARD/HEALTHZ",
      "/x/../__guard/healthz",
    ]) {
      const res = await request(path);
      expect(res.status, path).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("honors a custom HEALTH_PATH", async () => {
    await guard.shutdown(0);
    await startGuard(config({ healthPath: "/healthz" }));
    expect((await request("/healthz")).status).toBe(200);
    expect((await request("/__guard/healthz")).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe("guard: shutdown", () => {
  it("lets an in-flight request finish, then stops listening", async () => {
    let release!: () => void;
    let arrived!: () => void;
    const inFlight = new Promise<void>((r) => (arrived = r));
    upstreamHandler = (_req, res) => {
      arrived();
      release = () => res.end("done");
    };
    const pending = request("/slow", auth());
    await inFlight;
    const stopped = guard.shutdown(5000);
    release();
    expect((await pending).body).toBe("done");
    await stopped;
    await expect(request("/", auth())).rejects.toThrow();
    // afterEach shuts down again; make that a no-op.
    guard = { server: guard.server, shutdown: async () => {} };
  });
});

describe("stripAccessCookie", () => {
  it("removes only the Access cookie", () => {
    expect(stripAccessCookie("a=1; CF_Authorization=x.y.z; b=2")).toBe("a=1; b=2");
    expect(stripAccessCookie("CF_Authorization=x")).toBeUndefined();
    expect(stripAccessCookie(" CF_Authorization = x ;;")).toBeUndefined();
    expect(stripAccessCookie("CF_Authorization_extra=1; xCF_Authorization=2")).toBe("CF_Authorization_extra=1; xCF_Authorization=2");
    expect(stripAccessCookie("session=CF_Authorization=1")).toBe("session=CF_Authorization=1");
  });
});
