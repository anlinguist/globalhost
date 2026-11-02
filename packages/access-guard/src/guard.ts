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

export interface GuardOptions {
  keys?: KeySource;
  log?: Logger;
  /** Seconds since epoch; for tests. */
  now?: () => number;
  /** Upstream host; always loopback in production. */
  upstreamHost?: string;
}

export interface Guard {
  server: http.Server;
  /** Stop accepting, let in-flight requests finish for up to `graceMs`, then cut the rest. */
  shutdown(graceMs: number): Promise<void>;
}

function deny(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Names listed in a Connection header are hop-by-hop for this message too. */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    joined
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
}

/** Flat [name, value, name, value, ...] list without hop-by-hop or `drop`ped fields. */
function filterRaw(raw: string[], connection: Set<string>, drop: (lower: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connection.has(lower) || drop(lower)) continue;
    out.push(name, raw[i + 1]!);
  }
  return out;
}

/**
 * The Access credential is valid on every `*.globalhost.ai` preview, and preview app
 * code is untrusted (agent-written). So the app never gets it: not the header, not
 * the CF_Authorization cookie, nor Cloudflare's identity header (which a direct
 * caller could forge anyway).
 */
const ACCESS_CREDENTIAL_HEADERS = new Set([TOKEN_HEADER, "cf-access-authenticated-user-email"]);
const ACCESS_COOKIE = "cf_authorization";

/** Remove the Access cookie from one Cookie header value; undefined if nothing is left. */
export function stripAccessCookie(value: string): string | undefined {
  const kept = value
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "" && c.split("=", 1)[0]!.trim().toLowerCase() !== ACCESS_COOKIE);
  return kept.length === 0 ? undefined : kept.join("; ");
}

function upstreamRequestHeaders(req: IncomingMessage): string[] {
  const connection = connectionTokens(req.headers.connection);
  const filtered = filterRaw(
    req.rawHeaders,
    connection,
    (lower) => lower.startsWith(RESERVED_PREFIX) || lower === "x-forwarded-host" || ACCESS_CREDENTIAL_HEADERS.has(lower),
  );
  const headers: string[] = [];
  for (let i = 0; i + 1 < filtered.length; i += 2) {
    const name = filtered[i]!;
    let value: string | undefined = filtered[i + 1]!;
    if (name.toLowerCase() === "cookie") value = stripAccessCookie(value);
    if (value !== undefined) headers.push(name, value);
  }
  const forwardedHost = req.headersDistinct["x-forwarded-host"]?.[0] ?? req.headers.host;
  if (forwardedHost) headers.push("X-Forwarded-Host", forwardedHost);
  return headers;
}

export function createGuard(config: GuardConfig, opts: GuardOptions = {}): Guard {
  const log = opts.log ?? silentLogger;
  const keys = opts.keys ?? new JwksCache({ url: config.jwksUrl, log });
  const upstreamHost = opts.upstreamHost ?? "127.0.0.1";
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
    if (!url.startsWith("/")) {
      log("WARNING", "request rejected", { reason: "bad_request_target", method: req.method });
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

    proxyReq.on("response", (proxyRes) => {
      if (res.destroyed) {
        proxyRes.destroy();
        return;
      }
      const connection = connectionTokens(proxyRes.headers.connection);
      const headers = filterRaw(proxyRes.rawHeaders, connection, () => false);
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, headers);
      pipeline(proxyRes, res, () => {});
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        log("ERROR", "upstream error", { reason: (err as NodeJS.ErrnoException).code ?? err.name });
        deny(res, 502, "Bad Gateway\n");
      } else {
        res.destroy();
      }
    });

    // Client went away before the response finished: stop talking to the app.
    res.on("close", () => {
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
