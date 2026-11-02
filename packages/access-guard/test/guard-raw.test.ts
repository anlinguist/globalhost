/**
 * Byte-level tests: a raw TCP "app" records exactly what the guard sends and can
 * answer with responses Node's http server would never produce.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuard, type Guard } from "../src/guard.js";
import { JwksCache } from "../src/jwks.js";
import type { LogFields, Logger } from "../src/log.js";
import { AUD, ISSUER, NOW, TEAM, close, listen, makeKey, sign, startJwks, type JwksServer } from "./helpers.js";

const key = makeKey("k1");
const token = sign(key);

let jwks: JwksServer;
let app: net.Server;
let appPort: number;
/** Everything the app received, across all connections. */
let received: string;
/** What the app writes back once it has seen a full request head. */
let reply: string | undefined;
let guard: Guard;
let guardPort: number;
let logs: { message: string; fields?: LogFields }[];

beforeAll(async () => {
  jwks = await startJwks([key.jwk]);
  app = net.createServer((sock) => {
    sock.on("error", () => {});
    let buf = "";
    let answered = false;
    sock.on("data", (d: Buffer) => {
      received += d.toString("latin1");
      buf += d.toString("latin1");
      if (!answered && buf.includes("\r\n\r\n") && reply !== undefined) {
        answered = true;
        sock.write(reply, "latin1");
        // One exchange per connection, so the guard's keep-alive agent never reuses it.
        setTimeout(() => sock.end(), 50);
      }
    });
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  appPort = (app.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await close(jwks.server);
});

async function start(upstreamTimeoutMs?: number) {
  const log: Logger = (_s, message, fields) => logs.push({ message, fields });
  guard = createGuard(
    { port: 0, upstreamPort: appPort, teamDomain: TEAM, issuer: ISSUER, audiences: [AUD], jwksUrl: jwks.url, healthPath: "/__guard/healthz" },
    { keys: new JwksCache({ url: jwks.url }), log, now: () => NOW, upstreamTimeoutMs },
  );
  guardPort = await listen(guard.server);
}

beforeEach(async () => {
  received = "";
  logs = [];
  reply = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok";
  await start();
});
afterEach(() => guard.shutdown(0));

/** Send raw bytes; resolve with whatever comes back once the guard closes or `waitMs` passes. */
function send(text: string, waitMs = 400): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const sock = net.connect(guardPort, "127.0.0.1", () => sock.write(text, "latin1"));
    let out = "";
    let closed = false;
    sock.on("data", (d: Buffer) => (out += d.toString("latin1")));
    sock.on("error", () => {});
    sock.on("end", () => (closed = true));
    sock.on("close", () => {
      clearTimeout(t);
      resolve({ text: out, closed: true });
    });
    const t = setTimeout(() => {
      sock.destroy();
      resolve({ text: out, closed });
    }, waitMs);
  });
}

const requestLines = (s: string) => s.match(/^[A-Z]+ \S+ HTTP\/1\.1\r$/gm) ?? [];
const head = (extra: string, line = "GET / HTTP/1.1") => `${line}\r\nHost: x\r\nCf-Access-Jwt-Assertion: ${token}\r\n${extra}`;

describe("request framing (smuggling)", () => {
  it("re-chunks a chunked GET body, so it can't become a second request upstream", async () => {
    const inner = "GET /smuggled HTTP/1.1\r\nHost: x\r\nX-Globalhost-Owner: 1\r\nCf-Access-Authenticated-User-Email: owner@x\r\n\r\n";
    const body = `${inner.length.toString(16)}\r\n${inner}\r\n0\r\n\r\n`;
    const res = await send(`${head("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")}${body}`);
    expect(res.text).toMatch(/^HTTP\/1\.1 200/);
    const split = received.indexOf("\r\n\r\n");
    expect(requestLines(received.slice(0, split + 2))).toEqual(["GET / HTTP/1.1\r"]);
    expect(received.slice(0, split)).toMatch(/\r\nTransfer-Encoding: chunked$|\r\nTransfer-Encoding: chunked\r\n/);
    // The rest is exactly one chunked body: any compliant parser sees one request whose body is `inner`.
    expect(received.slice(split + 4)).toBe(body);
  });

  it("keeps Content-Length and Host even when Connection names them", async () => {
    await send(`${head("Content-Length: 4\r\nConnection: content-length, host, transfer-encoding\r\n\r\n", "POST / HTTP/1.1")}abcd`);
    expect(received).toMatch(/\r\nContent-Length: 4\r\n/);
    expect(received).toMatch(/\r\nHost: x\r\n/);
    expect(received.endsWith("\r\n\r\nabcd")).toBe(true);
    expect(requestLines(received)).toHaveLength(1);
  });

  it("rejects Transfer-Encoding with Content-Length, and non-chunked codings", async () => {
    for (const extra of ["Transfer-Encoding: chunked\r\nContent-Length: 5\r\n", "Transfer-Encoding: gzip, chunked\r\n"]) {
      const res = await send(`${head(`${extra}\r\n`, "POST / HTTP/1.1")}0\r\n\r\n`);
      expect(res.text, extra).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(received).toBe("");
  });
});

describe("misbehaving app", () => {
  const bad: [string, string][] = [
    ["status 000", "HTTP/1.1 000 OK\r\nContent-Length: 0\r\n\r\n"],
    ["status 99", "HTTP/1.1 099 OK\r\nContent-Length: 0\r\n\r\n"],
    ["status 600", "HTTP/1.1 600 OK\r\nContent-Length: 0\r\n\r\n"],
    ["unsolicited 101", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: upgrade\r\n\r\n"],
    ["garbage", "NOT HTTP AT ALL\r\n\r\n"],
  ];
  for (const [name, r] of bad) {
    it(`${name} -> 502, and the guard keeps serving`, async () => {
      reply = r;
      const res = await send(head("Connection: close\r\n\r\n"));
      expect(res.text).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
      reply = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok";
      expect((await send(head("Connection: close\r\n\r\n"))).text).toMatch(/^HTTP\/1\.1 200/);
    });
  }

  it("does not forward the app's reason phrase, even a malformed one", async () => {
    for (const r of ["HTTP/1.1 200 Totally Custom\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 200 O\x01K\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"]) {
      reply = r;
      const res = await send(head("Connection: close\r\n\r\n"));
      expect(res.text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    }
  });

  it("rewrites Set-Cookie: no Domain, no Cloudflare cookies", async () => {
    reply =
      "HTTP/1.1 200 OK\r\nSet-Cookie: sid=1; Domain=globalhost.ai; Path=/\r\nSet-Cookie: CF_Authorization=forged; Domain=globalhost.ai\r\nContent-Length: 0\r\n\r\n";
    const res = await send(head("Connection: close\r\n\r\n"));
    expect(res.text).toMatch(/\r\nset-cookie: sid=1; Path=\/\r\n/i);
    expect(res.text).not.toMatch(/CF_Authorization|Domain=/i);
  });

  it("times out an app that never answers with 504", async () => {
    await guard.shutdown(0);
    await start(200);
    reply = undefined;
    const res = await send(head("Connection: close\r\n\r\n"), 1000);
    expect(res.text).toMatch(/^HTTP\/1\.1 504/);
    expect(logs.some((l) => l.fields?.reason === "upstream_timeout")).toBe(true);
  });
});

describe("rejections close the connection", () => {
  it("403 says Connection: close and the socket ends, even with an unread body", async () => {
    const res = await send(`POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\npartial`, 2000);
    expect(res.text).toMatch(/^HTTP\/1\.1 403/);
    expect(res.text).toMatch(/\r\nConnection: close\r\n/i);
    expect(res.closed).toBe(true);
    expect(received).toBe("");
  });

  it("a request pipelined after a 403 is never processed", async () => {
    const res = await send(`GET / HTTP/1.1\r\nHost: x\r\n\r\n${head("\r\n")}`);
    expect(res.text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(["HTTP/1.1 403"]);
    expect(received).toBe("");
  });
});
