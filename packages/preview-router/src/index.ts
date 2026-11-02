// Cloudflare Worker: routes *.globalhost.ai preview hosts to Cloud Run tagged revisions (ADR-0007).
//
// This file must stay import-free so `tsc` emits one self-contained ES module that the Pulumi
// Cloudflare provider uploads as the Worker script. It runs behind a Cloudflare Access application;
// the access-guard sidecar on Cloud Run re-checks the Access JWT, so this Worker only routes.

/** Worker bindings. `PREVIEW_SERVICES` is a plain-text var: JSON `{ "<product>-<part>": "<base host>" }`. */
export interface Env {
  PREVIEW_SERVICES?: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const ZONE = "globalhost.ai";

export type ParsedHost =
  | { kind: "pr"; product: string; part: string; key: string; pr: number }
  | { kind: "dev"; product: string; part: string; key: string };

const PR_HOST = /^(.+)-([a-z][a-z0-9]*)-pr-([1-9][0-9]{0,6})\.globalhost\.ai$/;
const DEV_HOST = /^(.+)-([a-z][a-z0-9]*)-dev\.globalhost\.ai$/;
const PRODUCT = /^[a-z][a-z0-9-]*$/;

/**
 * Parse a public hostname. Returns null for anything that is not exactly one label under the zone
 * shaped like `<product>-<part>-pr-<n>` or `<product>-<part>-dev`. Matching is case-sensitive on
 * purpose: Workers hand us a normalized (lowercase) URL, so anything else is not a host we serve.
 */
export function parseHost(hostname: string): ParsedHost | null {
  const label = hostname.endsWith(`.${ZONE}`) ? hostname.slice(0, -(ZONE.length + 1)) : null;
  // One level only; DNS labels are at most 63 octets.
  if (label === null || label.length === 0 || label.length > 63 || label.includes(".")) return null;
  // `--` covers punycode (`xn--`) and products that end in a hyphen.
  if (label.includes("--")) return null;
  const pr = PR_HOST.exec(hostname);
  if (pr) {
    const [, product, part, n] = pr as unknown as [string, string, string, string];
    if (!PRODUCT.test(product)) return null;
    return { kind: "pr", product, part, key: `${product}-${part}`, pr: Number(n) };
  }
  const dev = DEV_HOST.exec(hostname);
  if (dev) {
    const [, product, part] = dev as unknown as [string, string, string];
    if (!PRODUCT.test(product)) return null;
    return { kind: "dev", product, part, key: `${product}-${part}` };
  }
  return null;
}

// New-style deterministic URL `<service>-<project-number>.<region>.run.app`, or the old
// `<service>-<hash>-<region-code>.a.run.app`. Neither may already carry a `---` tag.
const NEW_BASE = /^[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/;
const OLD_BASE = /^[a-z0-9-]+-[a-z0-9]+\.a\.run\.app$/;
const KEY = /^[a-z][a-z0-9-]*-[a-z][a-z0-9]*$/;

export function isValidBaseHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    !host.includes("---") &&
    (NEW_BASE.test(host) || OLD_BASE.test(host))
  );
}

/**
 * Parse the service map. Invalid entries are dropped; a value that is not a JSON object yields an
 * empty map, so every request 404s (fail closed). Lookups go through a `Map` of own keys, so keys
 * such as `__proto__` or `constructor` can never resolve to anything inherited.
 */
export function parseServiceMap(raw: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (typeof raw !== "string") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (KEY.test(key) && !key.includes("--") && isValidBaseHost(value)) out.set(key, value);
  }
  return out;
}

// Parsed once per isolate; keyed on the raw string so a changed var (new deploy) is re-read.
let cachedRaw: string | undefined;
let cachedMap: ReadonlyMap<string, string> | undefined;
function serviceMap(env: Env): ReadonlyMap<string, string> {
  if (cachedMap === undefined || cachedRaw !== env.PREVIEW_SERVICES) {
    cachedRaw = env.PREVIEW_SERVICES;
    cachedMap = parseServiceMap(env.PREVIEW_SERVICES);
  }
  return cachedMap;
}

/** The Cloud Run origin host for a parsed public host, or null when the product/part is unknown. */
export function originHostFor(parsed: ParsedHost, services: ReadonlyMap<string, string>): string | null {
  const base = services.get(parsed.key);
  if (base === undefined) return null;
  const tag = parsed.kind === "pr" ? `pr-${parsed.pr}` : "dev";
  return `${tag}---${base}`;
}

function notFound(): Response {
  return new Response("No preview for this PR (yet).\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

function plain(status: number, text: string): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

/** Rewrite an absolute Location on the origin host back to the public host; leave others alone. */
export function rewriteLocation(location: string, originHost: string, publicHost: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // relative: already resolves against the public host
  }
  if (url.hostname !== originHost || url.port !== "") return location;
  url.protocol = "https:";
  url.hostname = publicHost;
  return url.toString();
}

/** Client-supplied headers that could spoof identity or origin to the preview. */
const DROP_REQUEST_HEADERS = ["host", "forwarded", "x-real-ip", "cf-access-authenticated-user-email"];

const ACCESS_COOKIE = "cf_authorization";

function cookieName(pair: string): string {
  const eq = pair.indexOf("=");
  return (eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
}

/** Remove the Access session cookie (`CF_Authorization`) from a request `Cookie` header. */
export function stripAccessCookie(cookie: string): string {
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && cookieName(p) !== ACCESS_COOKIE)
    .join("; ");
}

/**
 * Make a response cookie host-only (drop any `Domain=`), so one preview can't set cookies for
 * sibling previews or other *.globalhost.ai hosts. Returns null to drop a `CF_Authorization` cookie.
 */
export function rewriteSetCookie(setCookie: string): string | null {
  const [pair = "", ...attrs] = setCookie.split(";");
  if (cookieName(pair) === ACCESS_COOKIE) return null;
  const kept = attrs.filter((a) => cookieName(a) !== "domain");
  return [pair, ...kept].join(";");
}

/** Handle one request. `fetchImpl` is injectable for tests. */
export async function handle(request: Request, env: Env, fetchImpl: FetchLike = fetch): Promise<Response> {
  const incoming = new URL(request.url);
  const parsed = parseHost(incoming.hostname);
  if (parsed === null) return notFound();
  const originHost = originHostFor(parsed, serviceMap(env));
  if (originHost === null) return notFound();

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-globalhost-") || lower.startsWith("x-forwarded-")) headers.delete(name);
  }
  for (const name of DROP_REQUEST_HEADERS) headers.delete(name);
  // The owner's Access session cookie must never reach preview (untrusted) code.
  const cookie = headers.get("cookie");
  if (cookie !== null) {
    const kept = stripAccessCookie(cookie);
    if (kept === "") headers.delete("cookie");
    else headers.set("cookie", kept);
  }
  headers.set("x-forwarded-host", incoming.hostname);
  headers.set("x-forwarded-proto", "https");
  // Cf-Access-Jwt-Assertion is carried over by the copy above; access-guard validates and strips it.

  const target = `https://${originHost}${incoming.pathname}${incoming.search}`;
  const init: RequestInit & { cf: Record<string, unknown>; duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    // Never serve a preview from Cloudflare's cache: negative TTL means "do not cache".
    cf: { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } },
  };
  if (request.body !== null) init.duplex = "half"; // required by Node's fetch for streamed bodies

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, init);
  } catch {
    return plain(502, "Preview origin unreachable.");
  }

  // WebSocket upgrades: hand back the upstream response untouched so its socket stays attached.
  if (upstream.status === 101) return upstream;

  const response = new Response(upstream.body, upstream);
  const location = response.headers.get("location");
  if (location !== null) {
    response.headers.set("location", rewriteLocation(location, originHost, incoming.hostname));
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    response.headers.delete("set-cookie");
    for (const sc of setCookies) {
      const rewritten = rewriteSetCookie(sc);
      if (rewritten !== null) response.headers.append("set-cookie", rewritten);
    }
  }
  if (!response.headers.has("x-robots-tag")) response.headers.set("x-robots-tag", "noindex");
  return response;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
