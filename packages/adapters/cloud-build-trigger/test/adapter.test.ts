import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildStatus,
  cloudBuildTrigger,
  cloudBuildTriggerConfigSchema,
  CloudBuildApiError,
  CloudRunApiError,
  imageMatch,
  parseImageRef,
  servingRevision,
  createCloudBuildTriggerAdapter,
  STATUS_MAP,
  type CloudBuildTriggerConfig,
} from "../src/index.js";

// Recorded-shape Cloud Build v1 responses (hand-written from the API reference; ids and project are fictional).
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const TOKEN = "ya29.test-token-not-real";
const TRIGGER_ID = "0f6b1c3e-5d2a-4f7e-9a8b-1c2d3e4f5a6b";
const SHA_PAGE1 = "1".repeat(40);
const SHA_PAGE2 = "3".repeat(40);
const SHA_MISSING = "a".repeat(40);

type Route = { status?: number; body: unknown };

/** A fetch fake keyed by path + search; records every request so tests can assert on URLs and headers. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: URL; method: string; headers: Record<string, string> }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const key = `${url.pathname}${url.search}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify(fixture("error-not-found")), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const LOC = "/v1/projects/example-prod/locations/global";
const listQuery = (page?: string) =>
  `?filter=${encodeURIComponent(`trigger_id="${TRIGGER_ID}"`).replace(/%20/g, "+")}&pageSize=50${page ? `&pageToken=${page}` : ""}`;
const PAGE2_TOKEN = (fixture("builds-page1") as { nextPageToken: string }).nextPageToken;

const standardRoutes: Record<string, Route> = {
  [`${LOC}/triggers/deploy-main`]: { body: fixture("trigger") },
  [`${LOC}/builds${listQuery()}`]: { body: fixture("builds-page1") },
  [`${LOC}/builds${listQuery(PAGE2_TOKEN)}`]: { body: fixture("builds-page2") },
  [`${LOC}/builds/c4a8e2f0-6b1d-4c9a-b7e3-5f0a1b2c3d4e`]: { body: fixture("build-success") },
};

const cfg: CloudBuildTriggerConfig = cloudBuildTriggerConfigSchema.parse({ project: "example-prod", trigger: "deploy-main" });
const ctx = (sha: string) => ({ product: "example", part: "web", sha, environment: { gcpProject: "example-prod", region: "us-central1" } });

function adapter(routes = standardRoutes) {
  const f = fakeFetch(routes);
  return { adapter: createCloudBuildTriggerAdapter({ accessToken: async () => TOKEN, fetch: f.fetch }), calls: f.calls };
}

describe("cloud-build-trigger config", () => {
  it("defaults region to global and accepts a trigger name or id", () => {
    expect(cfg).toEqual({ project: "example-prod", trigger: "deploy-main", region: "global" });
    expect(cloudBuildTriggerConfigSchema.safeParse({ project: "example-prod", trigger: TRIGGER_ID, region: "us-central1" }).success).toBe(true);
  });

  it.each([
    ["a placeholder trigger", { project: "example-prod", trigger: "<trigger-name>" }],
    ["a trigger with a path", { project: "example-prod", trigger: "../builds" }],
    ["a bad project", { project: "Example_Prod", trigger: "t" }],
    ["a bad region", { project: "example-prod", trigger: "t", region: "us central" }],
    ["an unknown key", { project: "example-prod", trigger: "t", branch: "main" }],
    ["a missing trigger", { project: "example-prod" }],
  ])("rejects %s", (_name, value) => {
    expect(cloudBuildTriggerConfigSchema.safeParse(value).success).toBe(false);
  });

  it("is observe-only", () => {
    expect(cloudBuildTrigger.capabilities).toEqual({ preview: false, canary: false, rollback: false, asyncGate: false });
    expect(cloudBuildTrigger.rollback).toBeUndefined();
    expect(cloudBuildTrigger.preview).toBeUndefined();
  });
});

describe("release()", () => {
  it("resolves the trigger, finds the build for the merge SHA and records its id", async () => {
    const { adapter: a, calls } = adapter();
    const handle = await a.release(ctx(SHA_PAGE1), cfg);
    expect(handle).toEqual({
      adapter: "cloud-build-trigger",
      sha: SHA_PAGE1,
      data: { project: "example-prod", region: "global", triggerId: TRIGGER_ID, buildId: "7d0f4a52-91c3-4b8e-a6d1-3e5f7a9b0c21" },
    });
    expect(calls.map((c) => c.url.pathname)).toEqual([`${LOC}/triggers/deploy-main`, `${LOC}/builds`]);
    expect(calls[1]?.url.searchParams.get("filter")).toBe(`trigger_id="${TRIGGER_ID}"`);
    for (const c of calls) {
      expect(c.url.origin).toBe("https://cloudbuild.googleapis.com");
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("pages through builds and picks the newest build for the SHA (a re-run supersedes a cancelled one)", async () => {
    const { adapter: a, calls } = adapter();
    const handle = await a.release(ctx(SHA_PAGE2), cfg);
    expect(handle.data.buildId).toBe("c4a8e2f0-6b1d-4c9a-b7e3-5f0a1b2c3d4e");
    expect(calls.at(-1)?.url.searchParams.get("pageToken")).toBe(PAGE2_TOKEN);
  });

  it("returns a handle without a build id when the trigger hasn't started a build yet", async () => {
    const { adapter: a } = adapter();
    const handle = await a.release(ctx(SHA_MISSING), cfg);
    expect(handle.data).toEqual({ project: "example-prod", region: "global", triggerId: TRIGGER_ID });
  });

  it("never starts, retries or cancels a build: every request is a GET", async () => {
    const { adapter: a, calls } = adapter();
    await a.release(ctx(SHA_PAGE2), cfg);
    await a.status({ adapter: "cloud-build-trigger", sha: SHA_PAGE2, data: { project: "example-prod", region: "global", triggerId: TRIGGER_ID } });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET" && !/:(?:run|cancel|retry|approve)$/.test(c.url.pathname))).toBe(true);
  });

  it("uses the configured region in the URL", async () => {
    const regional = Object.fromEntries(Object.entries(standardRoutes).map(([k, v]) => [k.replace("/locations/global/", "/locations/us-central1/"), v]));
    const { adapter: a, calls } = adapter(regional);
    await a.release(ctx(SHA_PAGE1), { ...cfg, region: "us-central1" });
    expect(calls[0]?.url.pathname).toBe("/v1/projects/example-prod/locations/us-central1/triggers/deploy-main");
  });

  it("rejects a SHA that isn't 40 lowercase hex characters before calling the API", async () => {
    const { adapter: a, calls } = adapter();
    await expect(a.release(ctx("HEAD"), cfg)).rejects.toThrow(/40 lowercase hex/);
    await expect(a.release(ctx(`${SHA_PAGE1}"`), cfg)).rejects.toThrow(/40 lowercase hex/);
    expect(calls).toEqual([]);
  });

  it("surfaces API errors with the HTTP and API status, never the token", async () => {
    const { adapter: a } = adapter({ [`${LOC}/triggers/deploy-main`]: { status: 403, body: fixture("error-permission-denied") } });
    const err = await a.release(ctx(SHA_PAGE1), cfg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudBuildApiError);
    expect((err as Error).message).toBe("Cloud Build API get trigger: HTTP 403 PERMISSION_DENIED");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("reports an unknown trigger as NOT_FOUND", async () => {
    const { adapter: a } = adapter({});
    await expect(a.release(ctx(SHA_PAGE1), cfg)).rejects.toThrow("Cloud Build API get trigger: HTTP 404 NOT_FOUND");
  });

  it("rejects a response that doesn't match the Build shape", async () => {
    const { adapter: a } = adapter({
      ...standardRoutes,
      [`${LOC}/builds${listQuery()}`]: { body: { builds: [{ id: "../../etc", status: "SUCCESS" }] } },
    });
    await expect(a.release(ctx(SHA_PAGE1), cfg)).rejects.toThrow("unexpected response shape");
  });

  it("ignores builds from another trigger that ran the same commit", async () => {
    const page = fixture("builds-page1") as { builds: Array<Record<string, unknown>> };
    const other = { ...page.builds[0], buildTriggerId: "99999999-0000-4000-8000-000000000000" };
    const { adapter: a } = adapter({ ...standardRoutes, [`${LOC}/builds${listQuery()}`]: { body: { builds: [other] } } });
    expect((await a.release(ctx(SHA_PAGE1), cfg)).data.buildId).toBeUndefined();
  });

  it("the registered (validation-only) adapter fails without a token provider", async () => {
    await expect(cloudBuildTrigger.release(ctx(SHA_PAGE1), cfg)).rejects.toThrow("no access-token provider");
  });
});

describe("status()", () => {
  const handle = (data: Record<string, string>, sha = SHA_PAGE2) => ({ adapter: "cloud-build-trigger", sha, data });
  const base = { project: "example-prod", region: "global", triggerId: TRIGGER_ID };

  it("reads a recorded build directly", async () => {
    const { adapter: a, calls } = adapter();
    const status = await a.status(handle({ ...base, buildId: "c4a8e2f0-6b1d-4c9a-b7e3-5f0a1b2c3d4e" }));
    expect(status).toEqual({
      state: "succeeded",
      detail: "Cloud Build c4a8e2f0-6b1d-4c9a-b7e3-5f0a1b2c3d4e: SUCCESS",
      url: "https://console.cloud.google.com/cloud-build/builds/c4a8e2f0-6b1d-4c9a-b7e3-5f0a1b2c3d4e?project=123456789012",
    });
    expect(calls).toHaveLength(1);
  });

  it("searches again when release() found no build yet", async () => {
    const { adapter: a } = adapter();
    expect((await a.status(handle(base))).state).toBe("running");
    expect(await a.status(handle(base, SHA_MISSING))).toEqual({ state: "pending", detail: `no Cloud Build build for ${SHA_MISSING} yet` });
  });

  it("includes the failure detail", async () => {
    const { adapter: a } = adapter();
    const status = await a.status(handle(base, "2".repeat(40)));
    expect(status.state).toBe("failed");
    expect(status.detail).toContain("FAILURE (Build step failure");
  });

  it.each([
    ["another adapter's handle", { adapter: "cloud-run", sha: SHA_PAGE2, data: base }],
    ["a tampered build id", { adapter: "cloud-build-trigger", sha: SHA_PAGE2, data: { ...base, buildId: "../../x" } }],
    ["a tampered project", { adapter: "cloud-build-trigger", sha: SHA_PAGE2, data: { ...base, project: "a/b" } }],
    ["an extra key", { adapter: "cloud-build-trigger", sha: SHA_PAGE2, data: { ...base, token: "x" } }],
    ["a bad sha", { adapter: "cloud-build-trigger", sha: "main", data: base }],
  ])("rejects %s without calling the API", async (_name, h) => {
    const { adapter: a, calls } = adapter();
    await expect(a.status(h)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("Cloud Build status mapping", () => {
  it.each([
    ["STATUS_UNKNOWN", "unknown"],
    ["PENDING", "pending"],
    ["QUEUED", "pending"],
    ["WORKING", "running"],
    ["SUCCESS", "succeeded"],
    ["FAILURE", "failed"],
    ["INTERNAL_ERROR", "failed"],
    ["TIMEOUT", "failed"],
    ["EXPIRED", "failed"],
    ["CANCELLED", "cancelled"],
    ["SOMETHING_NEW", "unknown"],
  ])("%s → %s", (raw, state) => {
    expect(buildStatus({ id: "b1", status: raw }).state).toBe(state);
  });

  it("covers every documented Build.Status except STATUS_UNKNOWN explicitly", () => {
    expect(Object.keys(STATUS_MAP).sort()).toEqual(["CANCELLED", "EXPIRED", "FAILURE", "INTERNAL_ERROR", "PENDING", "QUEUED", "SUCCESS", "TIMEOUT", "WORKING"]);
  });

  it("drops a log URL that isn't the Cloud console", () => {
    expect(buildStatus({ id: "b1", status: "SUCCESS", logUrl: "https://evil.example/x" }).url).toBeUndefined();
  });
});

describe("cloudRun deploy target config", () => {
  it("accepts a service and region", () => {
    expect(cloudBuildTriggerConfigSchema.parse({ project: "example-prod", trigger: "t", cloudRun: { service: "numu-know", region: "us-central1" } }).cloudRun).toEqual({
      service: "numu-know",
      region: "us-central1",
    });
  });

  it.each([
    ["an uppercase service", { service: "Numu", region: "us-central1" }],
    ["a service with a path", { service: "a/../b", region: "us-central1" }],
    ["a service ending in a hyphen", { service: "web-", region: "us-central1" }],
    ["a 50-character service", { service: `a${"b".repeat(49)}`, region: "us-central1" }],
    ["a global region", { service: "web", region: "global" }],
    ["a missing region", { service: "web" }],
    ["a missing service", { region: "us-central1" }],
    ["a project override", { service: "web", region: "us-central1", project: "other-prod" }],
  ])("rejects %s", (_name, cloudRun) => {
    expect(cloudBuildTriggerConfigSchema.safeParse({ project: "example-prod", trigger: "t", cloudRun }).success).toBe(false);
  });
});

describe("verifyLive()", () => {
  const BUILD_ID = "c4a8e2f0-6b1d-4c9a-b7e3-5f0a1b2c3d4e";
  const SHA = "3".repeat(40);
  const RUN = "/v2/projects/example-prod/locations/us-central1/services/example-app";
  const target = { project: "example-prod", region: "global", triggerId: TRIGGER_ID, buildId: BUILD_ID, runProject: "example-prod", runRegion: "us-central1", runService: "example-app" };
  const handle = (data: Record<string, string> = target, sha = SHA) => ({ adapter: "cloud-build-trigger", sha, data });
  const run = (f: string) => fixture(`cloud-run/${f}`);

  function routes(build: string, service: string | Route, revisions: Record<string, string> = {}): Record<string, Route> {
    return {
      [`${LOC}/builds/${BUILD_ID}`]: { body: run(build) },
      [RUN]: typeof service === "string" ? { body: run(service) } : service,
      ...Object.fromEntries(Object.entries(revisions).map(([name, f]) => [`${RUN}/revisions/${name}`, { body: run(f) }])),
    };
  }
  const NEW = "example-app-00042-xoz";
  const OLD = "example-app-00041-bed";

  it("release() records the target from cloudRun and the prod project", async () => {
    const { adapter: a } = adapter();
    const h = await a.release(
      { ...ctx(SHA_PAGE1), environment: { gcpProject: "example-prod", region: "us-central1" } },
      cloudBuildTriggerConfigSchema.parse({ project: "example-prod", trigger: "deploy-main", cloudRun: { service: "example-app", region: "us-central1" } }),
    );
    expect(h.data).toMatchObject({ runProject: "example-prod", runRegion: "us-central1", runService: "example-app" });
    // No usable prod project: no target, so nothing can be claimed deployed.
    const none = await a.release({ ...ctx(SHA_PAGE1), environment: { gcpProject: "", region: "" } }, cloudBuildTriggerConfigSchema.parse({ project: "example-prod", trigger: "deploy-main", cloudRun: { service: "example-app", region: "us-central1" } }));
    expect(none.data.runService).toBeUndefined();
  });

  it("live by digest: 100% on the latest ready revision, which runs the image the build pushed", async () => {
    const { adapter: a, calls } = adapter(routes("build-images", "service-latest", { [NEW]: "revision-new-digest" }));
    expect(await a.verifyLive!(handle())).toEqual({ state: "live", via: "digest" });
    expect(calls.map((c) => `${c.method} ${c.url.origin}${c.url.pathname}`)).toEqual([
      `GET https://cloudbuild.googleapis.com${LOC}/builds/${BUILD_ID}`,
      `GET https://run.googleapis.com${RUN}`,
      `GET https://run.googleapis.com${RUN}/revisions/${NEW}`,
    ]);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("live by a short-SHA tag in the repository the build pushed to", async () => {
    const { adapter: a } = adapter(routes("build-images", "service-latest", { [NEW]: "revision-new-tag" }));
    expect(await a.verifyLive!(handle())).toEqual({ state: "live", via: "tag" });
  });

  it("a SHA tag in another repository isn't this build's image", async () => {
    const { adapter: a } = adapter(routes("build-images", "service-latest", { [NEW]: "revision-other-repo" }));
    expect(await a.verifyLive!(handle())).toEqual({ state: "not-live", reason: "not-updated", final: false });
  });

  it("a no-op build (no images) is final not-live, without reading Cloud Run", async () => {
    const { adapter: a, calls } = adapter(routes("build-noop", "service-latest", { [NEW]: "revision-new-digest" }));
    expect(await a.verifyLive!(handle())).toEqual({ state: "not-live", reason: "no-artifact", final: true });
    expect(calls.some((c) => c.url.host === "run.googleapis.com")).toBe(false);
  });

  it("the service still on an older revision is not live", async () => {
    const { adapter: a } = adapter(routes("build-images", "service-old", { [OLD]: "revision-old" }));
    expect(await a.verifyLive!(handle())).toEqual({ state: "not-live", reason: "not-updated", final: false });
  });

  it("split traffic is not live, even with the new revision in the split", async () => {
    const { adapter: a } = adapter(routes("build-images", "service-split", { [NEW]: "revision-new-digest", [OLD]: "revision-old" }));
    expect(await a.verifyLive!(handle())).toEqual({ state: "not-live", reason: "split-traffic", final: false });
  });

  it("a reconciling service or a revision that isn't ready is not live yet", async () => {
    const r1 = adapter(routes("build-images", "service-reconciling", { [OLD]: "revision-old" }));
    expect(await r1.adapter.verifyLive!(handle())).toEqual({ state: "not-live", reason: "not-ready", final: false });
    const r2 = adapter(routes("build-images", "service-latest", { [NEW]: "revision-new-not-ready" }));
    expect(await r2.adapter.verifyLive!(handle())).toEqual({ state: "not-live", reason: "not-ready", final: false });
  });

  it("without a target it's unverifiable and reads nothing", async () => {
    const { adapter: a, calls } = adapter({});
    const noTarget = Object.fromEntries(Object.entries(target).filter(([k]) => !k.startsWith("run")));
    expect(await a.verifyLive!(handle(noTarget))).toEqual({ state: "unverifiable", reason: "no-target" });
    expect(calls).toEqual([]);
  });

  it("API errors throw (callers fail closed), with the HTTP and API status only", async () => {
    const { adapter: a } = adapter(routes("build-images", { status: 403, body: fixture("error-permission-denied") }));
    const err = await a.verifyLive!(handle()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudRunApiError);
    expect((err as CloudRunApiError).httpStatus).toBe(403);
    expect((err as Error).message).toBe("Cloud Run API get service: HTTP 403 PERMISSION_DENIED");
    // A missing revision too.
    const r2 = adapter(routes("build-images", "service-old"));
    await expect(r2.adapter.verifyLive!(handle())).rejects.toThrow("Cloud Run API get revision: HTTP 404 NOT_FOUND");
  });

  it("rejects a malformed service response", async () => {
    const { adapter: a } = adapter(routes("build-images", { body: { trafficStatuses: [{ revision: NEW, percent: "100" }] } }));
    await expect(a.verifyLive!(handle())).rejects.toThrow("Cloud Run API get service: unexpected response shape");
  });

  it("refuses a build that isn't a successful build of this commit", async () => {
    const { adapter: a } = adapter(routes("build-images", "service-latest", { [NEW]: "revision-new-digest" }));
    await expect(a.verifyLive!(handle(target, "4".repeat(40)))).rejects.toThrow("not a successful build of this commit");
  });

  it.each([
    ["a partial target", { ...target, runService: undefined }],
    ["a tampered service", { ...target, runService: "../x" }],
    ["a tampered run project", { ...target, runProject: "a/b" }],
    ["a global run region", { ...target, runRegion: "global" }],
  ])("rejects %s without calling the API", async (_name, data) => {
    const { adapter: a, calls } = adapter({});
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Record<string, string>;
    await expect(a.verifyLive!(handle(clean))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("liveness helpers", () => {
  it("parses image references (registry ports aren't tags)", () => {
    expect(parseImageRef("localhost:5000/app")).toEqual({ repo: "localhost:5000/app" });
    expect(parseImageRef("localhost:5000/app:abc")).toEqual({ repo: "localhost:5000/app", tag: "abc" });
    expect(parseImageRef("gcr.io/p/app:abc@sha256:00")).toEqual({ repo: "gcr.io/p/app", tag: "abc", digest: "sha256:00" });
  });

  it("requires the serving container to match; a matching sidecar proves nothing", () => {
    const sha = "3".repeat(40);
    const d = (c: string) => `sha256:${c.repeat(64)}`;
    const pushed = { digests: new Set([d("a"), d("b")]), repos: new Set(["r/app", "r/sidecar"]) };
    const rev = (...containers: Array<{ image: string; ports?: unknown[] }>) => ({ containers });
    // Old app, unchanged (reproducible) sidecar: not live.
    expect(imageMatch(rev({ image: `r/app@${d("0")}`, ports: [{}] }, { image: `r/sidecar@${d("b")}` }), sha, pushed)).toBeUndefined();
    // New app, sidecar from a pushed repo but an old digest: not live.
    expect(imageMatch(rev({ image: `r/app@${d("a")}`, ports: [{}] }, { image: `r/sidecar@${d("0")}` }), sha, pushed)).toBeUndefined();
    // New app, sidecar from a repo the build doesn't push: live.
    expect(imageMatch(rev({ image: `r/app@${d("a")}`, ports: [{}] }, { image: "otel/collector:1" }), sha, pushed)).toBe("digest");
    // Several containers, none with ports: ambiguous, not live.
    expect(imageMatch(rev({ image: `r/app@${d("a")}` }, { image: `r/sidecar@${d("b")}` }), sha, pushed)).toBeUndefined();
    // One container without ports is the serving one.
    expect(imageMatch(rev({ image: `r/app:${sha.slice(0, 7)}` }), sha, pushed)).toBe("tag");
  });

  it("finds the serving revision only at 100%", () => {
    expect(servingRevision({ trafficStatuses: [] })).toEqual({ reason: "not-updated" });
    expect(servingRevision({ trafficStatuses: [{ revision: "a-1", percent: 100 }, { revision: "b-1" }] })).toEqual({ revision: "a-1" });
    expect(servingRevision({ trafficStatuses: [{ revision: "a-1", percent: 50 }] })).toEqual({ reason: "split-traffic" });
    expect(servingRevision({ trafficStatuses: [{ revision: "../a", percent: 100 }] })).toEqual({ reason: "not-updated" });
    expect(servingRevision({ trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }] })).toEqual({ reason: "not-updated" });
  });
});
