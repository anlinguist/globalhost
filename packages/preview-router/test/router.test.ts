import { describe, expect, it } from "vitest";
import worker, {
  handle,
  isValidBaseHost,
  parseHost,
  parseServiceMap,
  rewriteLocation,
  type Env,
  type FetchLike,
} from "../src/index.js";

const BASE = "numu-know-web-preview-414694776649.us-central1.run.app";
const env: Env = {
  PREVIEW_SERVICES: JSON.stringify({
    "numu-know-web": BASE,
    "biblia-api": "biblia-api-preview-abc123xyz-uc.a.run.app",
  }),
};

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Response = () => new Response("ok")): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

async function run(url: string, opts: { init?: RequestInit; env?: Env; respond?: Parameters<typeof fakeFetch>[0] } = {}) {
  const f = fakeFetch(opts.respond);
  const res = await handle(new Request(url, opts.init), opts.env ?? env, f.fetch);
  return { res, calls: f.calls };
}

describe("parseHost", () => {
  it("parses a PR host, reading product from the right so it may contain hyphens", () => {
    expect(parseHost("numu-know-web-pr-12.globalhost.ai")).toEqual({
      kind: "pr",
      product: "numu-know",
      part: "web",
      key: "numu-know-web",
      pr: 12,
    });
    expect(parseHost("a-b-c-d-api2-pr-1.globalhost.ai")).toMatchObject({ product: "a-b-c-d", part: "api2", pr: 1 });
  });

  it("parses a dev host", () => {
    expect(parseHost("numu-know-web-dev.globalhost.ai")).toEqual({
      kind: "dev",
      product: "numu-know",
      part: "web",
      key: "numu-know-web",
    });
  });

  it.each([
    ["apex", "globalhost.ai"],
    ["app", "app.globalhost.ai"],
    ["other single label", "www.globalhost.ai"],
    ["uppercase", "NUMU-know-web-pr-12.globalhost.ai"],
    ["uppercase part", "numu-know-WEB-pr-12.globalhost.ai"],
    ["punycode", "xn--bcher-kva-web-pr-1.globalhost.ai"],
    ["double hyphen product", "numu--know-web-pr-1.globalhost.ai"],
    ["product ending in hyphen", "numu--web-pr-1.globalhost.ai"],
    ["extra level", "x.numu-know-web-pr-12.globalhost.ai"],
    ["extra level dev", "a.numu-know-web-dev.globalhost.ai"],
    ["leading zero", "numu-know-web-pr-012.globalhost.ai"],
    ["pr-0", "numu-know-web-pr-0.globalhost.ai"],
    ["too many digits", "numu-know-web-pr-12345678.globalhost.ai"],
    ["missing part", "numu-pr-12.globalhost.ai"],
    ["product starts with digit", "1numu-web-pr-1.globalhost.ai"],
    ["hyphen in part (only via product)", "-web-pr-1.globalhost.ai"],
    ["other zone", "numu-know-web-pr-12.globalhost.ai.evil.com"],
    ["lookalike zone", "numu-know-web-pr-12.notglobalhost.ai"],
    ["suffix without dot", "numu-know-web-pr-12globalhost.ai"],
    ["trailing dot", "numu-know-web-pr-12.globalhost.ai."],
    ["run.app", "pr-12---numu-know-web.run.app"],
    ["staging suffix", "numu-know-web-staging.globalhost.ai"],
    ["label over 63", `${"a".repeat(60)}-web-pr-1.globalhost.ai`],
  ])("rejects %s", (_name, host) => {
    expect(parseHost(host)).toBeNull();
  });
});

describe("service map", () => {
  it("accepts new- and old-style base hosts", () => {
    expect(isValidBaseHost(BASE)).toBe(true);
    expect(isValidBaseHost("svc-abc123xyz-uc.a.run.app")).toBe(true);
  });

  it.each([
    ["other domain", "evil.com"],
    ["run.app as subdomain", "run.app.evil.com"],
    ["suffix lookalike", "svc-1.us-central1.run.app.evil.com"],
    ["bare run.app", "run.app"],
    ["one label", "svc.run.app"],
    ["extra level", "a.svc-1.us-central1.run.app"],
    ["scheme", "https://svc-1.us-central1.run.app"],
    ["path", "svc-1.us-central1.run.app/x"],
    ["port", "svc-1.us-central1.run.app:443"],
    ["userinfo", "u@svc-1.us-central1.run.app"],
    ["uppercase", "SVC-1.us-central1.run.app"],
    ["already tagged", "pr-1---svc-1.us-central1.run.app"],
    ["number", 42],
    ["null", null],
  ])("rejects base host: %s", (_name, value) => {
    expect(isValidBaseHost(value)).toBe(false);
    expect(parseServiceMap(JSON.stringify({ "numu-know-web": value })).size).toBe(0);
  });

  it("drops invalid entries but keeps valid ones", () => {
    const map = parseServiceMap(JSON.stringify({ "numu-know-web": BASE, "bad-web": "evil.com" }));
    expect([...map.keys()]).toEqual(["numu-know-web"]);
  });

  it.each([
    ["not JSON", "{"],
    ["array", JSON.stringify([BASE])],
    ["string", JSON.stringify(BASE)],
    ["null", "null"],
    ["missing", undefined],
  ])("fails closed on %s", (_name, raw) => {
    expect(parseServiceMap(raw).size).toBe(0);
  });

  it("ignores prototype keys", () => {
    const map = parseServiceMap(`{"__proto__":"${BASE}","constructor":"${BASE}","toString":"${BASE}"}`);
    expect(map.size).toBe(0);
  });

  it("ignores keys that are not <product>-<part>", () => {
    const map = parseServiceMap(JSON.stringify({ web: BASE, "Numu-web": BASE, "numu--web": BASE, "numu-web-": BASE }));
    expect(map.size).toBe(0);
  });
});

describe("handle: routing", () => {
  it("proxies a PR host to the tagged revision URL with path and query", async () => {
    const { res, calls } = await run("https://numu-know-web-pr-12.globalhost.ai/stories/a?b=1&c=2");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://pr-12---${BASE}/stories/a?b=1&c=2`);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init as { cf?: unknown }).cf).toEqual({
      cacheEverything: false,
      cacheTtlByStatus: { "100-599": -1 },
    });
  });

  it("proxies an old-style base host", async () => {
    const { calls } = await run("https://biblia-api-pr-3.globalhost.ai/");
    expect(calls[0]!.url).toBe("https://pr-3---biblia-api-preview-abc123xyz-uc.a.run.app/");
  });

  it("proxies a dev host to the dev tag", async () => {
    const { calls } = await run("https://numu-know-web-dev.globalhost.ai/x");
    expect(calls[0]!.url).toBe(`https://dev---${BASE}/x`);
  });

  it("works through the default export's shape", () => {
    expect(typeof worker.fetch).toBe("function");
  });

  it.each([
    "https://globalhost.ai/",
    "https://app.globalhost.ai/",
    "https://x.numu-know-web-pr-12.globalhost.ai/",
    "https://numu-know-web-pr-0.globalhost.ai/",
    "https://numu-know-web-pr-012.globalhost.ai/",
    "https://xn--bcher-kva-web-pr-1.globalhost.ai/",
    "https://unknown-web-pr-1.globalhost.ai/",
    "https://numu-know-api-pr-1.globalhost.ai/",
    "https://__proto__-pr-1.globalhost.ai/",
    "https://constructor-web-pr-1.globalhost.ai/",
  ])("404s without fetching: %s", async (url) => {
    const { res, calls } = await run(url);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No preview for this PR (yet)");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(calls).toHaveLength(0);
  });

  it("404s everything when the map is invalid or missing", async () => {
    for (const e of [{}, { PREVIEW_SERVICES: "nope" }, { PREVIEW_SERVICES: '{"numu-know-web":"evil.com"}' }]) {
      const { res, calls } = await run("https://numu-know-web-pr-12.globalhost.ai/", { env: e });
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });

  it("re-reads the map when the var changes", async () => {
    await run("https://numu-know-web-pr-1.globalhost.ai/");
    const other = { PREVIEW_SERVICES: JSON.stringify({ "numu-know-web": "other-1.europe-west1.run.app" }) };
    const { calls } = await run("https://numu-know-web-pr-1.globalhost.ai/", { env: other });
    expect(calls[0]!.url).toBe("https://pr-1---other-1.europe-west1.run.app/");
  });

  it("passes an origin 404 (missing tag) through", async () => {
    const { res } = await run("https://numu-know-web-pr-9.globalhost.ai/", {
      respond: () => new Response("Page not found", { status: 404 }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Page not found");
  });

  it("returns 502 when the origin is unreachable", async () => {
    const { res } = await run("https://numu-know-web-pr-9.globalhost.ai/", {
      respond: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(res.status).toBe(502);
  });
});

describe("handle: headers", () => {
  it("forwards the Access JWT, sets forwarding headers, strips X-Globalhost-* and Host", async () => {
    const { calls } = await run("https://numu-know-web-pr-12.globalhost.ai/", {
      init: {
        headers: {
          "cf-access-jwt-assertion": "jwt.value.sig",
          "x-globalhost-trusted": "1",
          "X-Globalhost-Owner": "yes",
          "x-forwarded-host": "evil.com",
          "x-forwarded-proto": "http",
          cookie: "a=b",
          accept: "text/html",
        },
      },
    });
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("cf-access-jwt-assertion")).toBe("jwt.value.sig");
    expect(h.get("x-forwarded-host")).toBe("numu-know-web-pr-12.globalhost.ai");
    expect(h.get("x-forwarded-proto")).toBe("https");
    expect(h.get("x-globalhost-trusted")).toBeNull();
    expect(h.get("x-globalhost-owner")).toBeNull();
    expect(h.get("host")).toBeNull();
    expect(h.get("cookie")).toBe("a=b");
    expect(h.get("accept")).toBe("text/html");
  });

  it("streams a request body with its method", async () => {
    const { calls } = await run("https://numu-know-web-pr-12.globalhost.ai/api", {
      init: { method: "POST", body: "payload", headers: { "content-type": "text/plain" } },
    });
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(init.body).text()).toBe("payload");
  });

  it("adds X-Robots-Tag only when absent and keeps origin cache headers", async () => {
    const plain = await run("https://numu-know-web-pr-12.globalhost.ai/", {
      respond: () => new Response("x", { headers: { "cache-control": "public, max-age=60" } }),
    });
    expect(plain.res.headers.get("x-robots-tag")).toBe("noindex");
    expect(plain.res.headers.get("cache-control")).toBe("public, max-age=60");
    const set = await run("https://numu-know-web-pr-12.globalhost.ai/", {
      respond: () => new Response("x", { headers: { "x-robots-tag": "none" } }),
    });
    expect(set.res.headers.get("x-robots-tag")).toBe("none");
  });

  it("rewrites a Location on the tagged origin back to the public host", async () => {
    const { res } = await run("https://numu-know-web-pr-12.globalhost.ai/login", {
      respond: () =>
        new Response(null, { status: 302, headers: { location: `https://pr-12---${BASE}/home?x=1#top` } }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://numu-know-web-pr-12.globalhost.ai/home?x=1#top");
  });

  it("leaves relative and third-party Locations alone", async () => {
    for (const location of ["/home", "https://accounts.google.com/o/oauth2", `https://pr-13---${BASE}/`, `https://${BASE}/`]) {
      const { res } = await run("https://numu-know-web-pr-12.globalhost.ai/", {
        respond: () => new Response(null, { status: 302, headers: { location } }),
      });
      expect(res.headers.get("location")).toBe(location);
    }
  });
});

describe("rewriteLocation", () => {
  const origin = `pr-12---${BASE}`;
  it("rewrites http and https on the origin host", () => {
    expect(rewriteLocation(`http://${origin}/a`, origin, "p.globalhost.ai")).toBe("https://p.globalhost.ai/a");
    expect(rewriteLocation(`https://${origin.toUpperCase()}/a`, origin, "p.globalhost.ai")).toBe("https://p.globalhost.ai/a");
  });
  it("leaves the origin host on another port alone", () => {
    expect(rewriteLocation(`https://${origin}:8443/a`, origin, "p.globalhost.ai")).toBe(`https://${origin}:8443/a`);
  });
});
