/**
 * The guard server: answer the health path itself, require a valid Access JWT on
 * everything else, and stream authorized requests to the app on 127.0.0.1.
 */
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import type { GuardConfig } from "./config.js";
import { JwksCache, type KeySource } from "./jwks.js";
import { verifyAccessJwt } from "./jwt.js";
import { silentLogger, type Logger } from "./log.js";

export const TOKEN_HEADER = "cf-access-jwt-assertion";
/** Header namespace reserved for the factory; clients can't set it. */
const RESERVED_PREFIX = "x-globalhost-";

// RFC 9110 §7.6.1 connection-specific fields, plus the legacy ones proxies drop.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
// A Connection header may not remove these: dropping them changes message framing
// (request smuggling) or routing. Transfer-Encoding is still hop-by-hop, but the
// guard re-sets framing itself.
const PROTECTED = new Set(["host", "content-length", "transfer-encoding"]);

/**
 * Cloudflare Access credentials. Each is valid on every `*.globalhost.ai` preview (or,
 * for service tokens, wherever the token's policy allows), and preview app code is
 * untrusted (agent-written), so the app never receives any of them. This also drops
 * `Cf-Access-Authenticated-User-Email`, which a direct caller could forge.
 */
const ACCESS_HEADER_PREFIX = "cf-access-";
/** CF_Authorization, CF_AppSession, CF_Binding, and any other Cloudflare cookie. */
const isCloudflareCookie = (name: string) => /^cf_/i.test(name.trim());

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;

export interface GuardOptions {
  keys?: KeySource;
  log?: Logger;
  /** Seconds since epoch; for tests. */
  now?: () => number;
  /** Upstream host; always loopback in production. */
  upstreamHost?: string;
  /** How long the app may take to send response headers. */
  upstreamTimeoutMs?: number;
}

export interface Guard {
  server: http.Server;
  /** Stop accepting, let in-flight requests finish for up to `graceMs`, then cut the rest. */
  shutdown(graceMs: number): Promise<void>;
}

/** Fixed-body error response; closes the connection so an unread body can't be reinterpreted. */
function deny(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  // Half-close after the response is flushed (a hard destroy with unread request
  // bytes can RST away the response), then cut the socket if the client lingers.
  const sock = res.req.socket;
  res.end(body, () => {
    sock.end();
    sock.setTimeout(5_000, () => sock.destroy());
  });
}

/** Names listed in a Connection header are hop-by-hop for this message too. */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    joined
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== "" && !PROTECTED.has(t)),
  );
}

/** Flat [name, value, ...] list without hop-by-hop fields, rewritten (or dropped, on undefined) by `map`. */
function filterRaw(raw: string[], connection: Set<string>, map: (lower: string, value: string) => string | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connection.has(lower)) continue;
    const value = map(lower, raw[i + 1]!);
    if (value !== undefined) out.push(name, value);
  }
  return out;
}

/** Remove Cloudflare cookies from one Cookie header value; undefined if nothing is left. */
export function stripAccessCookie(value: string): string | undefined {
  const kept = value
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "" && !isCloudflareCookie(c.split("=", 1)[0]!));
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * Drop an app's Set-Cookie for a Cloudflare cookie, and remove `Domain=` so the
 * cookie stays host-only: a preview can't set cookies on `globalhost.ai` that other
 * previews (or the factory app) would receive.
 */
export function rewriteSetCookie(value: string): string | undefined {
  const [pair, ...attrs] = value.split(";");
  if (isCloudflareCookie(pair!.split("=", 1)[0]!)) return undefined;
  return [pair!, ...attrs.filter((a) => a.split("=", 1)[0]!.trim().toLowerCase() !== "domain")].join(";");
}

function upstreamRequestHeaders(req: IncomingMessage): string[] {
  const headers = filterRaw(req.rawHeaders, connectionTokens(req.headers.connection), (lower, value) => {
    if (lower.startsWith(RESERVED_PREFIX) || lower.startsWith(ACCESS_HEADER_PREFIX) || lower === "x-forwarded-host") return undefined;
    if (lower === "cookie") return stripAccessCookie(value);
    return value;
  });
  const forwardedHost = req.headersDistinct["x-forwarded-host"]?.[0] ?? req.headers.host;
  if (forwardedHost) headers.push("X-Forwarded-Host", forwardedHost);
  // Content-Length (if any) passed through above. A chunked body is re-chunked by us.
  if (req.headers["transfer-encoding"] !== undefined) headers.push("Transfer-Encoding", "chunked");
  return headers;
}

/** Framing the guard can forward unambiguously, or a reason to refuse. */
function framingError(req: IncomingMessage): string | undefined {
  const te = req.headers["transfer-encoding"];
  if (te === undefined) return undefined;
  if (req.headers["content-length"] !== undefined) return "te_and_cl";
  if (te.trim().toLowerCase() !== "chunked") return "unsupported_te";
  return undefined;
}

export function createGuard(config: GuardConfig, opts: GuardOptions = {}): Guard {
  const log = opts.log ?? silentLogger;
  const keys = opts.keys ?? new JwksCache({ url: config.jwksUrl, log });
  const upstreamHost = opts.upstreamHost ?? "127.0.0.1";
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const agent = new http.Agent({ keepAlive: true });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    // Exact match on the path before any query. Anything else, including
    // `/__guard/healthz/../x` or encoded variants, goes through the token check.
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    if (path === config.healthPath) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "ok\n");
      return;
    }

    // Origin-form only: no absolute-form (`GET http://other/`) or `*` targets.
    const badRequest = !url.startsWith("/") ? "bad_request_target" : framingError(req);
    if (badRequest) {
      log("WARNING", "request rejected", { reason: badRequest, method: req.method });
      deny(res, 400, "Bad Request\n");
      return;
    }

    const tokens = req.headersDistinct[TOKEN_HEADER];
    const result =
      tokens && tokens.length > 1
        ? ({ ok: false, reason: "multiple_tokens" } as const)
        : await verifyAccessJwt(tokens?.[0], {
            issuer: config.issuer,
            audiences: config.audiences,
            keys,
            now: opts.now,
          });
    if (!result.ok) {
      log("WARNING", "request rejected", { reason: result.reason, method: req.method });
      deny(res, 403, "Forbidden\n");
      return;
    }
    if (req.destroyed) return;

    const proxyReq = http.request({
      host: upstreamHost,
      port: config.upstreamPort,
      method: req.method,
      path: url,
      headers: upstreamRequestHeaders(req) as unknown as OutgoingHttpHeaders,
      agent,
    });

    let failed = false;
    const fail = (reason: string, status = 502, body = "Bad Gateway\n") => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      log("ERROR", "upstream error", { reason });
      proxyReq.destroy();
      deny(res, status, body);
    };
    const timer = setTimeout(() => fail("upstream_timeout", 504, "Gateway Timeout\n"), upstreamTimeoutMs);

    proxyReq.on("response", (proxyRes) => {
      clearTimeout(timer);
      if (failed) return void proxyRes.destroy();
      if (res.destroyed) return void proxyRes.destroy();
      const status = proxyRes.statusCode ?? 0;
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        proxyRes.destroy();
        return fail("bad_upstream_status");
      }
      const headers = filterRaw(proxyRes.rawHeaders, connectionTokens(proxyRes.headers.connection), (lower, value) =>
        lower === "set-cookie" ? rewriteSetCookie(value) : value,
      );
      try {
        // The app's reason phrase is not forwarded; Node supplies the standard one.
        res.writeHead(status, headers);
      } catch {
        proxyRes.destroy();
        return fail("bad_upstream_headers");
      }
      pipeline(proxyRes, res, () => {});
    });

    // An app answering 101 would get a raw socket to the client: refuse.
    proxyReq.on("upgrade", (_res, socket) => {
      socket.destroy();
      fail("upstream_upgrade");
    });

    proxyReq.on("error", (err) => {
      if (failed) return;
      if (!res.headersSent) fail((err as NodeJS.ErrnoException).code ?? err.name);
      else {
        failed = true;
        clearTimeout(timer);
        res.destroy();
      }
    });

    // Client went away before the response finished: stop talking to the app.
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished) proxyReq.destroy();
    });

    pipeline(req, proxyReq, () => {});
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log("ERROR", "guard error", { reason: err instanceof Error ? err.name : "unknown" });
      deny(res, 500, "Internal Server Error\n");
    });
  });
  // Slow-loris bounds. requestTimeout covers receiving the request (headers + body),
  // not streaming the response.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  // WebSocket and other upgrades aren't proxied: answer 501 before touching auth or upstream.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    log("WARNING", "upgrade rejected", { reason: "upgrade_unsupported", method: req.method });
    socket.on("error", () => {});
    socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  // Unparseable requests (including headers over maxHeaderSize) never reach handle().
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const status = err.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });

  async function shutdown(graceMs: number): Promise<void> {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    await closed;
    clearTimeout(timer);
    agent.destroy();
  }

  return { server, shutdown };
}
