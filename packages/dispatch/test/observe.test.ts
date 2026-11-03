import { describe, expect, it } from "vitest";
import { cloudBuildTrigger } from "@globalhost/adapter-cloud-build-trigger";
import { createRegistry, z, type DeployAdapter, type ProfileDescriptor } from "@globalhost/core";
import { ACTIONS_BOT, NOT_LIVE_TEXT, buildLink, consoleUrl, factoryIssue, observeStep, releaseMarker, type ObserveDeps } from "../src/observe.js";
import { pullRequestBody } from "../src/publish.js";

const REPO = "anlinguist/demo";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const LOG_URL = "https://console.cloud.google.com/cloud-build/builds/build-1?project=demo-prod";
const SECRET = "STRIPE_KEY=sk_live_abc123 token ghp_secret";
const APP_BOT = "globalhost-ai[bot]";

const webApp: ProfileDescriptor = {
  id: "web-app",
  configSchema: z.object({}).passthrough(),
  preview: { kinds: ["url"], outputs: ["url"], inputs: [] },
  release: { allowedAdapters: ["cloud-build-trigger"] },
};
const registry = createRegistry([webApp], [cloudBuildTrigger]);

const PROD = `environments:
  prod: { gcpProject: demo-prod, region: us-central1 }
`;
const yaml = (parts: string, envs = PROD) => `version: 1
product: demo
owners:
  - { login: anlinguist, id: 47403803 }
${envs}parts:
${parts}
`;
const ONE_PART = yaml(`  web:
    path: .
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-web, cloudRun: { service: web, region: us-central1 } }`);
const TWO_PARTS = yaml(`  web:
    path: web
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-web, cloudRun: { service: web, region: us-central1 } }
  api:
    path: api
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-api, cloudRun: { service: api, region: us-central1 } }`);
const NO_TARGET = yaml(`  web:
    path: .
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-web }`);
const NO_PROD_ENV = yaml(
  `  web:
    path: .
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-web, cloudRun: { service: web, region: us-central1 } }`,
  `environments:
  dev: { gcpProject: demo-dev, region: us-central1 }
`,
);
const DIGEST = `sha256:${"d".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"e".repeat(64)}`;
const IMAGE = (svc: string) => `us-docker.pkg.dev/demo-prod/app/${svc}`;
const NO_RELEASE = yaml(`  web: { path: ., profile: web-app, preview: { enabled: false } }`);

interface Build {
  id: string;
  trigger: string;
  /** Statuses returned on successive reads; the last one repeats. */
  statuses: string[];
  statusDetail?: string;
  logUrl?: string;
  /** results.images; default: one image for the trigger's service, at DIGEST. */
  images?: Array<{ name: string; digest: string }>;
}

/** A Cloud Run service as the fake API serves it. Each read shifts `states` until one is left. */
interface RunService {
  states: Array<{ reconciling?: boolean; traffic: Array<{ revision: string; percent: number }> }>;
}
interface RunRevision {
  image: string;
  ready: boolean;
}

interface FakeComment {
  id: number;
  issue: number;
  body: string;
  user: { login: string; id: number; type: string };
}

type Pull = {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string; type: string } | null;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
};

const factoryPull = (n: number, issue: number, over: Partial<Pull> = {}): Pull => ({
  number: n,
  merged_at: "2026-11-01T00:00:00Z",
  merge_commit_sha: SHA,
  user: { login: APP_BOT, type: "Bot" },
  base: { ref: "main" },
  head: { ref: `factory/issue-${issue}`, repo: { full_name: REPO } },
  ...over,
});

class Fake {
  calls: string[] = [];
  configRefs: string[] = [];
  comments: FakeComment[] = [];
  issues = new Map<number, { state: string; state_reason?: string; labels: Set<string>; pull_request?: object }>();
  builds: Build[] = [];
  pulls: Pull[] = [];
  /** Cloud Run services by name; by default each serves 100% on a ready revision running DIGEST. */
  services = new Map<string, RunService>();
  revisions = new Map<string, RunRevision>();
  /** Commit the builds ran on. */
  buildSha = SHA;
  private nextId = 1000;

  constructor(public factoryYaml = ONE_PART) {}

  fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === "cloudbuild.googleapis.com") return this.cloudBuild(url);
    if (url.host === "run.googleapis.com") return this.cloudRun(url);
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (p === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (p === `/repos/${REPO}/contents/factory.yaml`) {
      this.configRefs.push(url.searchParams.get("ref") ?? "");
      return Response.json({ content: Buffer.from(this.factoryYaml).toString("base64"), encoding: "base64" });
    }
    if (p === `/repos/${REPO}/commits/${SHA}/pulls`) return Response.json(this.pulls);
    if ((m = /\/issues\/(\d+)\/comments$/.exec(p))) {
      const issue = Number(m[1]);
      if (method === "GET") return Response.json(this.comments.filter((c) => c.issue === issue));
      const c = { id: this.nextId++, issue, body: String(body!.body), user: { login: ACTIONS_BOT, id: 41898282, type: "Bot" } };
      this.comments.push(c);
      return Response.json(c, { status: 201 });
    }
    if (method === "PATCH" && (m = /\/issues\/comments\/(\d+)$/.exec(p))) {
      const c = this.comments.find((x) => x.id === Number(m![1]))!;
      c.body = String(body!.body);
      return Response.json(c);
    }
    if ((m = /\/issues\/(\d+)\/labels\/(.+)$/.exec(p)) && method === "DELETE") {
      const removed = this.issues.get(Number(m[1]))?.labels.delete(decodeURIComponent(m[2]!));
      return removed ? new Response(null, { status: 204 }) : new Response("{}", { status: 404 });
    }
    if ((m = /\/issues\/(\d+)$/.exec(p))) {
      const n = Number(m[1]);
      const issue = this.issues.get(n);
      if (!issue) return new Response("{}", { status: 404 });
      if (method === "PATCH") Object.assign(issue, body);
      return Response.json({ number: n, state: issue.state, ...(issue.pull_request ? { pull_request: issue.pull_request } : {}) });
    }
    return new Response(`no route ${method} ${p}`, { status: 404 });
  }) as typeof fetch;

  private cloudBuild(url: URL): Response {
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if ((m = /\/triggers\/([^/]+)$/.exec(p))) return Response.json({ id: `id-${m[1]}`, name: m[1] });
    const toApi = (b: Build, consume: boolean) => {
      const status = b.statuses.length > 1 && consume ? b.statuses.shift()! : b.statuses[0]!;
      return {
        id: b.id,
        status,
        statusDetail: b.statusDetail,
        buildTriggerId: `id-${b.trigger}`,
        substitutions: { COMMIT_SHA: this.buildSha, _SECRET: SECRET },
        createTime: "2026-11-01T00:00:00Z",
        logUrl: b.logUrl,
        results: { images: b.images ?? [{ name: `${IMAGE(b.trigger.replace(/^deploy-/, ""))}:${this.buildSha}`, digest: DIGEST }] },
      };
    };
    if (p.endsWith("/builds")) {
      const trig = /trigger_id="([^"]+)"/.exec(url.searchParams.get("filter") ?? "")?.[1];
      return Response.json({ builds: this.builds.filter((b) => `id-${b.trigger}` === trig).map((b) => toApi(b, false)) });
    }
    if ((m = /\/builds\/([^/]+)$/.exec(p))) {
      const b = this.builds.find((x) => x.id === m![1]);
      return b ? Response.json(toApi(b, true)) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }

  serve(svc: string, rev: RunRevision, revName = `${svc}-00002-new`) {
    this.services.set(svc, { states: [{ traffic: [{ revision: revName, percent: 100 }] }] });
    this.revisions.set(revName, rev);
  }

  private cloudRun(url: URL): Response {
    const m = /^\/v2\/projects\/demo-prod\/locations\/us-central1\/services\/([a-z0-9-]+)(?:\/revisions\/([a-z0-9-]+))?$/.exec(url.pathname);
    if (!m) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    const [, svc, rev] = m;
    if (!this.services.has(svc!)) this.serve(svc!, { image: `${IMAGE(svc!)}@${DIGEST}`, ready: true });
    if (rev) {
      const r = this.revisions.get(rev);
      if (!r) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
      return Response.json({
        name: `projects/demo-prod/locations/us-central1/services/${svc}/revisions/${rev}`,
        containers: [{ image: r.image }],
        conditions: [{ type: "Ready", state: r.ready ? "CONDITION_SUCCEEDED" : "CONDITION_RECONCILING" }],
      });
    }
    const s = this.services.get(svc!)!;
    const st = s.states.length > 1 ? s.states.shift()! : s.states[0]!;
    return Response.json({
      name: `projects/demo-prod/locations/us-central1/services/${svc}`,
      reconciling: st.reconciling ?? false,
      trafficStatuses: st.traffic.map((t) => ({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: t.revision, percent: t.percent })),
    });
  }

  issue(n: number, labels: string[] = ["factory:in-review"]) {
    this.issues.set(n, { state: "open", labels: new Set(labels) });
  }

  commentsOn(n: number) {
    return this.comments.filter((c) => c.issue === n);
  }
}

function deps(fake: Fake, env: Record<string, string> = {}, over: Partial<ObserveDeps> = {}): ObserveDeps & { logs: string[] } {
  const logs: string[] = [];
  let t = 0;
  return {
    env: { GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GITHUB_TOKEN: "ghs_workflowtoken", GITHUB_REF: "refs/heads/main", GLOBALHOST_APP_SLUG: "globalhost-ai", ...env },
    registry,
    log: (l) => logs.push(l),
    fetchImpl: fake.fetch,
    gcpToken: async () => "ya29.gcp-token",
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    logs,
    ...over,
  };
}

describe("observe step", () => {
  it("on success comments on the PR and the issue, and closes the issue", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["QUEUED", "WORKING", "SUCCESS"], logUrl: LOG_URL });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const d = deps(fake);
    const out = await observeStep(d);

    expect(out).toMatchObject({ outcome: "succeeded", pulls: [30], closedIssues: [12] });
    const pr = fake.commentsOn(30);
    expect(pr).toHaveLength(1);
    expect(pr[0]!.body).toBe(`Deployed to prod via Cloud Build \`build-1\` ✅\n[Build details](${LOG_URL})\n${releaseMarker(SHA)}`);
    const issue = fake.commentsOn(12);
    expect(issue).toHaveLength(1);
    expect(issue[0]!.body).toContain("Deployed to prod via Cloud Build `build-1` ✅");
    expect(issue[0]!.body).toContain("Merged in #30.");
    expect(fake.issues.get(12)).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(fake.issues.get(12)!.labels.has("factory:in-review")).toBe(false);
    // Tokens never reach the log.
    expect(d.logs.join("\n")).not.toMatch(/ghs_|ya29/);
  });

  it("on failure comments ❌ with the log link and leaves the issue open", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["WORKING", "TIMEOUT"], logUrl: LOG_URL, statusDetail: SECRET });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake));

    expect(out.outcome).toBe("failed");
    expect(fake.commentsOn(30)[0]!.body).toBe(`❌ Cloud Build \`build-1\` failed (TIMEOUT)\n[Build log](${LOG_URL})\n${releaseMarker(SHA)}`);
    expect(fake.commentsOn(12)[0]!.body).toContain("❌ Cloud Build `build-1` failed (TIMEOUT)");
    expect(fake.issues.get(12)).toMatchObject({ state: "open" });
    expect(fake.issues.get(12)!.labels).toEqual(new Set(["factory:in-review"]));
  });

  it("reports a cancelled build", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["CANCELLED"], logUrl: LOG_URL });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("failed");
    expect(fake.commentsOn(30)[0]!.body).toMatch(/^⚠️ Cloud Build `build-1` was cancelled\n/);
    expect(fake.issues.get(12)!.state).toBe("open");
  });

  it("reports not observed when no build shows up before the timeout", async () => {
    const fake = new Fake();
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const d = deps(fake, { OBSERVE_TIMEOUT_MINUTES: "5" });
    const out = await observeStep(d);
    expect(out.outcome).toBe("failed");
    expect(out.parts).toEqual([{ label: "web", outcome: "no-build" }]);
    expect(fake.commentsOn(30)[0]!.body).toBe(
      `⏳ No Cloud Build build for aaaaaaa found within 5 min; the trigger may not have fired.\n${releaseMarker(SHA)}`,
    );
    expect(fake.issues.get(12)!.state).toBe("open");
    // 5 min at 20 s per poll: bounded, not forever.
    expect(fake.calls.filter((c) => c.endsWith("/builds")).length).toBeLessThanOrEqual(17);
  });

  it("a build still running at the deadline is reported as such and doesn't fail the job", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["WORKING"], logUrl: LOG_URL });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake, { OBSERVE_TIMEOUT_MINUTES: "1", OBSERVE_POLL_SECONDS: "30" }));
    expect(out.outcome).toBe("pending");
    expect(out.parts[0]!.outcome).toBe("still-running");
    expect(fake.commentsOn(30)[0]!.body).toBe(`⏳ Cloud Build \`build-1\` still WORKING after 1 min.\n[Build log](${LOG_URL})\n${releaseMarker(SHA)}`);
    expect(fake.commentsOn(12)[0]!.body).toContain("still WORKING");
    expect(fake.issues.get(12)!.state).toBe("open");
  });

  it("a failure next to a still-running build fails the job", async () => {
    const fake = new Fake(TWO_PARTS);
    fake.builds.push(
      { id: "build-web", trigger: "deploy-web", statuses: ["WORKING"] },
      { id: "build-api", trigger: "deploy-api", statuses: ["FAILURE"] },
    );
    fake.pulls.push(factoryPull(30, 12));
    const out = await observeStep(deps(fake, { OBSERVE_TIMEOUT_MINUTES: "1" }));
    expect(out.outcome).toBe("failed");
  });

  it.each([401, 403, 404])("stops on Cloud Build HTTP %i and says so", async (code) => {
    const fake = new Fake();
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const real = fake.fetch;
    let cbCalls = 0;
    fake.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("cloudbuild.googleapis.com")) {
        cbCalls++;
        return Response.json({ error: { code, status: "PERMISSION_DENIED" } }, { status: code });
      }
      return real(input, init);
    }) as typeof fetch;
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("failed");
    expect(out.parts).toEqual([{ label: "web", outcome: "error", httpStatus: code }]);
    expect(cbCalls).toBe(1);
    expect(fake.commentsOn(30)[0]!.body).toBe(`⚠️ Couldn't read Cloud Build for web (HTTP ${code})\n${releaseMarker(SHA)}`);
    expect(fake.issues.get(12)!.state).toBe("open");
  });

  it("one part's error doesn't stop the others being reported", async () => {
    const fake = new Fake(TWO_PARTS);
    fake.builds.push({ id: "build-web", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const real = fake.fetch;
    fake.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/triggers/deploy-api")) return Response.json({ error: { code: 404 } }, { status: 404 });
      return real(input, init);
    }) as typeof fetch;
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("failed");
    expect(fake.commentsOn(30)[0]!.body).toBe(
      [
        "**web:** Deployed to prod via Cloud Build `build-web` ✅",
        "[Build details](https://console.cloud.google.com/cloud-build/builds/build-web?project=demo-prod)",
        "⚠️ Couldn't read Cloud Build for api (HTTP 404)",
        releaseMarker(SHA),
      ].join("\n"),
    );
    expect(fake.issues.get(12)!.state).toBe("open");
  });

  it("an unexpected adapter exception is reported as that part's error", async () => {
    const fake = new Fake();
    fake.pulls.push(factoryPull(30, 12));
    const adapter: DeployAdapter = {
      id: "cloud-build-trigger",
      configSchema: z.unknown(),
      capabilities: { preview: false, canary: false, rollback: false, asyncGate: false },
      release: async () => {
        throw new Error("boom: secret detail");
      },
      status: async () => ({ state: "unknown", detail: "" }),
    };
    const out = await observeStep(deps(fake, {}, { adapterFactory: () => adapter }));
    expect(out.parts[0]).toEqual({ label: "web", outcome: "error", httpStatus: undefined });
    expect(fake.commentsOn(30)[0]!.body).toBe(`⚠️ Couldn't read Cloud Build for web\n${releaseMarker(SHA)}`);
  });

  it("retries 429 and 5xx", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(30, 12));
    const real = fake.fetch;
    let n = 0;
    fake.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/triggers/") && n++ < 2) return Response.json({}, { status: n === 1 ? 429 : 500 });
      return real(input, init);
    }) as typeof fetch;
    expect((await observeStep(deps(fake))).outcome).toBe("succeeded");
  });

  it("reads factory.yaml at the released commit", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    await observeStep(deps(fake));
    expect(fake.configRefs).toEqual([SHA]);
  });

  it("closes the issue only for PRs the factory App opened", async () => {
    for (const user of [{ login: "anlinguist", type: "User" }, { login: "other-app[bot]", type: "Bot" }, { login: APP_BOT, type: "User" }, null]) {
      const fake = new Fake();
      fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
      fake.pulls.push(factoryPull(30, 12, { user }));
      fake.issue(12);
      const out = await observeStep(deps(fake));
      expect(out.closedIssues).toEqual([]);
      expect(fake.issues.get(12)!.state).toBe("open");
      expect(fake.commentsOn(30)).toHaveLength(1);
      expect(fake.commentsOn(12)).toHaveLength(0);
    }
  });

  it("requires a valid GLOBALHOST_APP_SLUG", async () => {
    for (const bad of ["", "Bad Slug", "x[bot]"]) {
      await expect(observeStep(deps(new Fake(), { GLOBALHOST_APP_SLUG: bad }))).rejects.toThrow(/GLOBALHOST_APP_SLUG/);
    }
  });

  it("re-runs update the earlier comment instead of adding another", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["FAILURE"], logUrl: LOG_URL });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    await observeStep(deps(fake));
    expect(fake.commentsOn(30)[0]!.body).toContain("❌");

    // An unrelated earlier comment by someone else carrying the marker is not touched.
    fake.comments.push({ id: 1, issue: 30, body: `spoof ${releaseMarker(SHA)}`, user: { login: "mallory", id: 666, type: "User" } });
    fake.builds[0]!.statuses = ["SUCCESS"];
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("succeeded");
    const bot = fake.commentsOn(30).filter((c) => c.user.login === ACTIONS_BOT);
    expect(bot).toHaveLength(1);
    expect(bot[0]!.body).toContain("✅");
    expect(fake.comments.find((c) => c.id === 1)!.body).toBe(`spoof ${releaseMarker(SHA)}`);
    expect(fake.commentsOn(12)).toHaveLength(1);
    expect(fake.issues.get(12)!.state).toBe("closed");
  });

  it("a comment for another sha is left alone", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    fake.comments.push({ id: 5, issue: 30, body: `old ${releaseMarker(OTHER_SHA)}`, user: { login: ACTIONS_BOT, id: 41898282, type: "Bot" } });
    await observeStep(deps(fake));
    expect(fake.commentsOn(30)).toHaveLength(2);
    expect(fake.comments.find((c) => c.id === 5)!.body).toBe(`old ${releaseMarker(OTHER_SHA)}`);
  });

  it("a non-factory merged PR gets the PR comment only", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(31, 0, { head: { ref: "owner/fix-typo", repo: { full_name: REPO } } }));
    fake.issue(12);
    const out = await observeStep(deps(fake));
    expect(out).toMatchObject({ outcome: "succeeded", pulls: [31], closedIssues: [] });
    expect(fake.commentsOn(31)).toHaveLength(1);
    expect(fake.comments).toHaveLength(1);
    expect(fake.calls.some((c) => /\/issues\/\d+$/.test(c))).toBe(false);
  });

  it("a fork's factory/issue-1 branch is not a factory PR", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(32, 1, { head: { ref: "factory/issue-1", repo: { full_name: "mallory/demo" } } }));
    fake.issue(1);
    const out = await observeStep(deps(fake));
    expect(out.closedIssues).toEqual([]);
    expect(fake.issues.get(1)!.state).toBe("open");
    expect(fake.commentsOn(1)).toHaveLength(0);
    expect(fake.commentsOn(32)).toHaveLength(1);
  });

  it("ignores PRs that weren't merged as this commit into the default branch", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(
      factoryPull(40, 12, { merged_at: null }),
      factoryPull(41, 12, { merge_commit_sha: OTHER_SHA }),
      factoryPull(42, 12, { base: { ref: "release" } }),
    );
    fake.issue(12);
    const out = await observeStep(deps(fake));
    expect(out.pulls).toEqual([]);
    expect(fake.comments).toHaveLength(0);
    expect(fake.issues.get(12)!.state).toBe("open");
  });

  it("does not close an 'issue' that is really a pull request", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(30, 29));
    fake.issues.set(29, { state: "open", labels: new Set(), pull_request: {} });
    const out = await observeStep(deps(fake));
    expect(out.closedIssues).toEqual([]);
    expect(fake.issues.get(29)!.state).toBe("open");
  });

  it("validates GITHUB_SHA before calling anything", async () => {
    for (const bad of ["", "A".repeat(40), "a".repeat(39), `${"a".repeat(40)}\n`, "main"]) {
      const fake = new Fake();
      await expect(observeStep(deps(fake, { GITHUB_SHA: bad }))).rejects.toThrow(/GITHUB_SHA/);
      expect(fake.calls).toEqual([]);
    }
  });

  it("validates the timeout", async () => {
    for (const bad of ["0", "61", "-5", "1.5", "abc"]) {
      await expect(observeStep(deps(new Fake(), { OBSERVE_TIMEOUT_MINUTES: bad }))).rejects.toThrow(/OBSERVE_TIMEOUT_MINUTES/);
    }
  });

  it("refuses to run off the default branch", async () => {
    await expect(observeStep(deps(new Fake(), { GITHUB_REF: "refs/heads/factory/issue-1" }))).rejects.toThrow(/default branch/);
    await expect(observeStep(deps(new Fake(), { GITHUB_REF: "" }))).rejects.toThrow(/GITHUB_REF/);
  });

  it("never puts statusDetail, substitutions or other build fields in a comment", async () => {
    for (const status of ["SUCCESS", "FAILURE", "INTERNAL_ERROR", "CANCELLED"]) {
      const fake = new Fake();
      fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: [status], statusDetail: SECRET, logUrl: LOG_URL });
      fake.pulls.push(factoryPull(30, 12));
      fake.issue(12);
      const d = deps(fake);
      await observeStep(d);
      for (const c of fake.comments) {
        expect(c.body).not.toContain("sk_live");
        expect(c.body).not.toContain("ghp_");
        expect(c.body).not.toContain("STRIPE");
      }
      expect(d.logs.join("\n")).not.toContain("sk_live");
    }
  });

  it("links the build by project ID, never Cloud Build's logUrl (which names the project by number)", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["FAILURE"], logUrl: "https://console.cloud.google.com/cloud-build/builds/build-1?project=123456789012" });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    await observeStep(deps(fake));
    expect(fake.commentsOn(30)[0]!.body).toBe(
      `❌ Cloud Build \`build-1\` failed (FAILURE)\n[Build log](https://console.cloud.google.com/cloud-build/builds/build-1?project=demo-prod)\n${releaseMarker(SHA)}`,
    );
    expect(fake.commentsOn(30)[0]!.body).not.toContain("123456789012");
    expect(buildLink({ adapter: "cloud-build-trigger", sha: SHA, data: { project: "demo-prod", region: "us-central1" } }, "b-1")).toBe(
      "https://console.cloud.google.com/cloud-build/builds;region=us-central1/b-1?project=demo-prod",
    );
    expect(buildLink({ adapter: "cloud-build-trigger", sha: SHA, data: { project: "demo-prod", region: "europe-west10" } }, "b-1")).toBe(
      "https://console.cloud.google.com/cloud-build/builds;region=europe-west10/b-1?project=demo-prod",
    );
    expect(buildLink({ adapter: "cloud-build-trigger", sha: SHA, data: { project: "x)](evil", region: "global" } }, "b-1")).toBeUndefined();
    expect(buildLink({ adapter: "cloud-build-trigger", sha: SHA, data: { project: "demo-prod", region: "global" } }, "b`1")).toBeUndefined();

    expect(consoleUrl(LOG_URL)).toBe(LOG_URL);
    expect(consoleUrl("http://console.cloud.google.com/x")).toBeUndefined();
    expect(consoleUrl("https://console.cloud.google.com.evil.example/x")).toBeUndefined();
    expect(consoleUrl("https://console.cloud.google.com@evil.example/x")).toBeUndefined();
    expect(consoleUrl("https://console.cloud.google.com/x)[click](https://evil.example")).toBeUndefined();
    expect(consoleUrl("https://console.cloud.google.com/x\n<!-- -->")).toBeUndefined();
    expect(consoleUrl(undefined)).toBeUndefined();
  });

  it("a crafted adapter detail can't inject a build id or state", async () => {
    const fake = new Fake();
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const adapter: DeployAdapter = {
      id: "cloud-build-trigger",
      configSchema: z.unknown(),
      capabilities: { preview: false, canary: false, rollback: false, asyncGate: false },
      release: async (ctx) => ({ adapter: "cloud-build-trigger", sha: ctx.sha, data: {} }),
      status: async () => ({ state: "failed", detail: "Cloud Build x`y: FAILURE @everyone", url: "javascript:alert(1)" }),
    };
    await observeStep(deps(fake, {}, { adapterFactory: () => adapter }));
    expect(fake.commentsOn(30)[0]!.body).toBe(`❌ Cloud Build (unknown id) failed (FAILURE)\n${releaseMarker(SHA)}`);
  });

  it("one line per part with several parts; any failure fails the release", async () => {
    const fake = new Fake(TWO_PARTS);
    fake.builds.push(
      { id: "build-web", trigger: "deploy-web", statuses: ["SUCCESS"], logUrl: LOG_URL },
      { id: "build-api", trigger: "deploy-api", statuses: ["WORKING", "FAILURE"] },
    );
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("failed");
    expect(fake.commentsOn(30)[0]!.body).toBe(
      [
        "**web:** Deployed to prod via Cloud Build `build-web` ✅",
        "[Build details](https://console.cloud.google.com/cloud-build/builds/build-web?project=demo-prod)",
        "**api:** ❌ Cloud Build `build-api` failed (FAILURE)",
        "[Build log](https://console.cloud.google.com/cloud-build/builds/build-api?project=demo-prod)",
        releaseMarker(SHA),
      ].join("\n"),
    );
    expect(fake.issues.get(12)!.state).toBe("open");
  });

  it("does nothing when no part releases through cloud-build-trigger", async () => {
    const fake = new Fake(NO_RELEASE);
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("no-release");
    expect(fake.comments).toHaveLength(0);
    expect(fake.calls.some((c) => c.includes("cloudbuild"))).toBe(false);
  });

  it("keeps polling through a transient Cloud Build error", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"] });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const real = fake.fetch;
    let failed = false;
    fake.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (!failed && String(input).includes("/builds/build-1")) {
        failed = true;
        return Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });
      }
      return real(input, init);
    }) as typeof fetch;
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("succeeded");
  });
});

describe("observe step: a successful build is not a deploy", () => {
  const success = (fake: Fake, over: Partial<Build> = {}) => {
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["SUCCESS"], logUrl: LOG_URL, ...over });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
  };
  const runCalls = (fake: Fake) => fake.calls.filter((c) => c.includes("run.googleapis.com"));
  const notLive = (text: string) =>
    `❌ Cloud Build \`build-1\` succeeded, but the merged commit isn't live: ${text}.\n[Build details](${LOG_URL})\n${releaseMarker(SHA)}`;
  const expectOpen = (fake: Fake) => {
    expect(fake.issues.get(12)).toMatchObject({ state: "open" });
    expect(fake.issues.get(12)!.labels.has("factory:in-review")).toBe(true);
    expect(fake.commentsOn(12)[0]!.body).not.toContain("✅");
  };

  it("✅ only when the service serves 100% on a ready revision running the build's digest", async () => {
    const fake = new Fake();
    success(fake);
    const out = await observeStep(deps(fake));
    expect(out).toMatchObject({ outcome: "succeeded", closedIssues: [12] });
    expect(runCalls(fake)).toEqual([
      "GET run.googleapis.com/v2/projects/demo-prod/locations/us-central1/services/web",
      "GET run.googleapis.com/v2/projects/demo-prod/locations/us-central1/services/web/revisions/web-00002-new",
    ]);
    expect(fake.calls.filter((c) => c.includes("run.googleapis.com")).every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("a no-op build (no images pushed) is never ✅, and Cloud Run isn't even read", async () => {
    // The numu-know case: the trigger's build was a single `echo` step.
    const fake = new Fake();
    success(fake, { images: [] });
    const d = deps(fake);
    const out = await observeStep(d);
    expect(out).toMatchObject({ outcome: "failed", closedIssues: [] });
    expect(out.parts[0]).toMatchObject({ outcome: "not-live", reason: "no-artifact" });
    expect(fake.commentsOn(30)[0]!.body).toBe(notLive(NOT_LIVE_TEXT["no-artifact"]));
    expect(runCalls(fake)).toEqual([]);
    expectOpen(fake);
  });

  it("an image without a valid digest doesn't count as built", async () => {
    const fake = new Fake();
    success(fake, { images: [{ name: `${IMAGE("web")}:${SHA}`, digest: "sha256:abc" }] });
    expect((await observeStep(deps(fake))).parts[0]).toMatchObject({ outcome: "not-live", reason: "no-artifact" });
  });

  it("the service still on an older revision is never ✅ (bounded wait, then ❌)", async () => {
    const fake = new Fake();
    success(fake);
    fake.serve("web", { image: `${IMAGE("web")}@${OTHER_DIGEST}`, ready: true }, "web-00001-old");
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("failed");
    expect(out.parts[0]).toMatchObject({ outcome: "not-live", reason: "not-updated" });
    expect(fake.commentsOn(30)[0]!.body).toBe(notLive(NOT_LIVE_TEXT["not-updated"]));
    expectOpen(fake);
    // 5 min at 20 s: bounded.
    expect(runCalls(fake).filter((c) => c.endsWith("/services/web")).length).toBeLessThanOrEqual(16);
  });

  it("an image tagged with another commit is not this deploy", async () => {
    const fake = new Fake();
    success(fake);
    fake.serve("web", { image: `${IMAGE("web")}:${OTHER_SHA}`, ready: true });
    expect((await observeStep(deps(fake))).parts[0]).toMatchObject({ outcome: "not-live", reason: "not-updated" });
  });

  it("a pinned digest that doesn't match wins over a matching tag", async () => {
    const fake = new Fake();
    success(fake);
    fake.serve("web", { image: `${IMAGE("web")}:${SHA}@${OTHER_DIGEST}`, ready: true });
    expect((await observeStep(deps(fake))).parts[0]).toMatchObject({ outcome: "not-live", reason: "not-updated" });
  });

  it("accepts a full or short SHA tag, but only in a repository the build pushed to", async () => {
    for (const [image, ok] of [
      [`${IMAGE("web")}:${SHA}`, true],
      [`${IMAGE("web")}:${SHA.slice(0, 7)}`, true],
      [`${IMAGE("web")}:${SHA.slice(0, 6)}`, false],
      [`us-docker.pkg.dev/elsewhere/app/web:${SHA}`, false],
      [`${IMAGE("web")}`, false],
    ] as const) {
      const fake = new Fake();
      success(fake);
      fake.serve("web", { image, ready: true });
      const out = await observeStep(deps(fake));
      expect([image, out.outcome]).toEqual([image, ok ? "succeeded" : "failed"]);
    }
  });

  it("split traffic is never ✅", async () => {
    const fake = new Fake();
    success(fake);
    fake.serve("web", { image: `${IMAGE("web")}@${DIGEST}`, ready: true });
    fake.services.set("web", { states: [{ traffic: [{ revision: "web-00002-new", percent: 90 }, { revision: "web-00001-old", percent: 10 }] }] });
    const out = await observeStep(deps(fake));
    expect(out.parts[0]).toMatchObject({ outcome: "not-live", reason: "split-traffic" });
    expect(fake.commentsOn(30)[0]!.body).toBe(notLive(NOT_LIVE_TEXT["split-traffic"]));
    expectOpen(fake);
  });

  it("a revision that never becomes ready is never ✅", async () => {
    const fake = new Fake();
    success(fake);
    fake.serve("web", { image: `${IMAGE("web")}@${DIGEST}`, ready: false });
    const out = await observeStep(deps(fake));
    expect(out.parts[0]).toMatchObject({ outcome: "not-live", reason: "not-ready" });
    expectOpen(fake);
  });

  it("waits for a rollout in progress, then reports ✅", async () => {
    const fake = new Fake();
    success(fake);
    fake.serve("web", { image: `${IMAGE("web")}@${DIGEST}`, ready: true });
    fake.revisions.set("web-00001-old", { image: `${IMAGE("web")}@${OTHER_DIGEST}`, ready: true });
    fake.services.set("web", {
      states: [
        { traffic: [{ revision: "web-00001-old", percent: 100 }] },
        { reconciling: true, traffic: [{ revision: "web-00001-old", percent: 100 }] },
        { traffic: [{ revision: "web-00002-new", percent: 100 }] },
      ],
    });
    const out = await observeStep(deps(fake));
    expect(out).toMatchObject({ outcome: "succeeded", closedIssues: [12] });
  });

  it("verification gets its own bounded window even when the build finishes at the build deadline", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["WORKING", "WORKING", "WORKING", "SUCCESS"] });
    fake.pulls.push(factoryPull(30, 12));
    fake.serve("web", { image: `${IMAGE("web")}@${DIGEST}`, ready: true });
    fake.revisions.set("web-00001-old", { image: `${IMAGE("web")}@${OTHER_DIGEST}`, ready: true });
    fake.services.set("web", { states: [{ traffic: [{ revision: "web-00001-old", percent: 100 }] }, { traffic: [{ revision: "web-00002-new", percent: 100 }] }] });
    const out = await observeStep(deps(fake, { OBSERVE_TIMEOUT_MINUTES: "1" }));
    expect(out.outcome).toBe("succeeded");
  });

  it("without a deploy target: a fixed 'can't be verified' status, no ✅, issue left open, job not failed", async () => {
    for (const config of [NO_TARGET, NO_PROD_ENV]) {
      const fake = new Fake(config);
      success(fake);
      const out = await observeStep(deps(fake));
      expect(out).toMatchObject({ outcome: "unverified", closedIssues: [] });
      expect(fake.commentsOn(30)[0]!.body).toBe(
        `Cloud Build \`build-1\` succeeded, but deployment can't be verified (no deploy target configured).\n[Build details](${LOG_URL})\n${releaseMarker(SHA)}`,
      );
      expect(runCalls(fake)).toEqual([]);
      expectOpen(fake);
    }
  });

  it("an adapter without verifyLive can never report deployed", async () => {
    const fake = new Fake();
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const adapter: DeployAdapter = {
      id: "cloud-build-trigger",
      configSchema: z.unknown(),
      capabilities: { preview: false, canary: false, rollback: false, asyncGate: false },
      release: async (ctx) => ({ adapter: "cloud-build-trigger", sha: ctx.sha, data: { project: "demo-prod", region: "global", buildId: "b-1" } }),
      status: async () => ({ state: "succeeded", detail: "Cloud Build b-1: SUCCESS" }),
    };
    const out = await observeStep(deps(fake, {}, { adapterFactory: () => adapter }));
    expect(out).toMatchObject({ outcome: "unverified", closedIssues: [] });
    expect(fake.commentsOn(30)[0]!.body).not.toContain("✅");
    expectOpen(fake);
  });

  it.each([401, 403, 404])("Cloud Run HTTP %i fails closed: ⚠️, issue open, job failed", async (code) => {
    const fake = new Fake();
    success(fake);
    const real = fake.fetch;
    fake.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("run.googleapis.com")) return Response.json({ error: { code, status: "PERMISSION_DENIED" } }, { status: code });
      return real(input, init);
    }) as typeof fetch;
    const out = await observeStep(deps(fake));
    expect(out).toMatchObject({ outcome: "failed", closedIssues: [] });
    expect(out.parts[0]).toMatchObject({ outcome: "verify-error", httpStatus: code });
    expect(fake.commentsOn(30)[0]!.body).toBe(
      `⚠️ Cloud Build \`build-1\` succeeded, but Cloud Run couldn't be read to confirm the deploy (HTTP ${code}).\n${releaseMarker(SHA)}`,
    );
    expectOpen(fake);
  });

  it("a Cloud Run 5xx that never clears fails closed after the verify window; one that clears doesn't", async () => {
    for (const persistent of [true, false]) {
      const fake = new Fake();
      success(fake);
      const real = fake.fetch;
      let n = 0;
      fake.fetch = (async (input: string | URL, init?: RequestInit) => {
        if (String(input).includes("run.googleapis.com") && (persistent || n++ === 0)) return Response.json({}, { status: 503 });
        return real(input, init);
      }) as typeof fetch;
      const out = await observeStep(deps(fake));
      expect(out.parts[0]!.outcome).toBe(persistent ? "verify-error" : "succeeded");
      expect(out.closedIssues).toEqual(persistent ? [] : [12]);
    }
  });

  it("a malformed Cloud Run response fails closed", async () => {
    const fake = new Fake();
    success(fake);
    const real = fake.fetch;
    fake.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("run.googleapis.com")) return Response.json({ trafficStatuses: [{ revision: "x", percent: 250 }] });
      return real(input, init);
    }) as typeof fetch;
    const out = await observeStep(deps(fake));
    expect(out.parts[0]).toMatchObject({ outcome: "verify-error" });
    expectOpen(fake);
  });

  it("comments never carry image, digest or revision names", async () => {
    for (const image of [`${IMAGE("web")}@${OTHER_DIGEST}`, `${IMAGE("web")}@${DIGEST}`]) {
      const fake = new Fake();
      success(fake);
      fake.serve("web", { image, ready: true }, "web-00002-secretname");
      await observeStep(deps(fake));
      for (const c of fake.comments) {
        expect(c.body).not.toMatch(/sha256|pkg\.dev|secretname|eeee/);
      }
    }
  });

  it("one part live and one not: ❌ for that part, nothing closes", async () => {
    const fake = new Fake(TWO_PARTS);
    fake.builds.push(
      { id: "build-web", trigger: "deploy-web", statuses: ["SUCCESS"] },
      { id: "build-api", trigger: "deploy-api", statuses: ["SUCCESS"], images: [] },
    );
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake));
    expect(out.outcome).toBe("failed");
    expect(fake.commentsOn(30)[0]!.body).toContain("**web:** Deployed to prod via Cloud Build `build-web` ✅");
    expect(fake.commentsOn(30)[0]!.body).toContain("**api:** ❌ Cloud Build `build-api` succeeded, but the merged commit isn't live");
    expect(fake.issues.get(12)!.state).toBe("open");
  });
});

describe("factoryIssue", () => {
  const pr = (ref: string, repo: string | null = REPO) => factoryPull(1, 0, { head: { ref, repo: repo ? { full_name: repo } : null } });
  it("matches only factory/issue-<n> in this repo, opened by the App", () => {
    expect(factoryIssue(pr("factory/issue-12"), REPO, APP_BOT)).toBe(12);
    expect(factoryIssue(pr("factory/issue-12"), REPO, "other[bot]")).toBeUndefined();
    expect(factoryIssue(pr("factory/issue-12", "mallory/demo"), REPO, APP_BOT)).toBeUndefined();
    expect(factoryIssue(pr("factory/issue-12", null), REPO, APP_BOT)).toBeUndefined();
    for (const ref of ["factory/issue-0", "factory/issue-012", "factory/issue-12x", "factory/issue-12345678", "xfactory/issue-1", "factory/issue-1/x"]) {
      expect(factoryIssue(pr(ref), REPO, APP_BOT)).toBeUndefined();
    }
  });
});

describe("factory PR body", () => {
  it("references the issue without a closing keyword", () => {
    const body = pullRequestBody(12);
    expect(body).toContain("#12");
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[\s:]*#\d+/i);
  });
});
