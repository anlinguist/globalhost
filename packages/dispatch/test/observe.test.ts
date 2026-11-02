import { describe, expect, it } from "vitest";
import { cloudBuildTrigger } from "@globalhost/adapter-cloud-build-trigger";
import { createRegistry, z, type DeployAdapter, type ProfileDescriptor } from "@globalhost/core";
import { ACTIONS_BOT, consoleUrl, factoryIssue, observeStep, releaseMarker, type ObserveDeps } from "../src/observe.js";
import { pullRequestBody } from "../src/publish.js";

const REPO = "anlinguist/demo";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const LOG_URL = "https://console.cloud.google.com/cloud-build/builds/build-1?project=demo-prod";
const SECRET = "STRIPE_KEY=sk_live_abc123 token ghp_secret";

const webApp: ProfileDescriptor = {
  id: "web-app",
  configSchema: z.object({}).passthrough(),
  preview: { kinds: ["url"], outputs: ["url"], inputs: [] },
  release: { allowedAdapters: ["cloud-build-trigger"] },
};
const registry = createRegistry([webApp], [cloudBuildTrigger]);

const yaml = (parts: string) => `version: 1
product: demo
owners:
  - { login: anlinguist, id: 47403803 }
parts:
${parts}
`;
const ONE_PART = yaml(`  web:
    path: .
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-web }`);
const TWO_PARTS = yaml(`  web:
    path: web
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-web }
  api:
    path: api
    profile: web-app
    preview: { enabled: false }
    release:
      - adapter: cloud-build-trigger
        config: { project: demo-prod, trigger: deploy-api }`);
const NO_RELEASE = yaml(`  web: { path: ., profile: web-app, preview: { enabled: false } }`);

interface Build {
  id: string;
  trigger: string;
  /** Statuses returned on successive reads; the last one repeats. */
  statuses: string[];
  statusDetail?: string;
  logUrl?: string;
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
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
};

const factoryPull = (n: number, issue: number, over: Partial<Pull> = {}): Pull => ({
  number: n,
  merged_at: "2026-11-01T00:00:00Z",
  merge_commit_sha: SHA,
  base: { ref: "main" },
  head: { ref: `factory/issue-${issue}`, repo: { full_name: REPO } },
  ...over,
});

class Fake {
  calls: string[] = [];
  comments: FakeComment[] = [];
  issues = new Map<number, { state: string; state_reason?: string; labels: Set<string>; pull_request?: object }>();
  builds: Build[] = [];
  pulls: Pull[] = [];
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
    const p = url.pathname;
    let m: RegExpExecArray | null;
    if (p === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (p === `/repos/${REPO}/contents/factory.yaml`) {
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
    env: { GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GITHUB_TOKEN: "ghs_workflowtoken", GITHUB_REF: "refs/heads/main", ...env },
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
    expect(out.parts).toEqual([{ label: "web", outcome: "not-observed" }]);
    expect(fake.commentsOn(30)[0]!.body).toBe(`⏳ No prod build observed for aaaaaaa within 5 min\n${releaseMarker(SHA)}`);
    expect(fake.issues.get(12)!.state).toBe("open");
    // 5 min at 20 s per poll: bounded, not forever.
    expect(fake.calls.filter((c) => c.endsWith("/builds")).length).toBeLessThanOrEqual(17);
  });

  it("a build still running at the deadline is not observed", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["WORKING"] });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    const out = await observeStep(deps(fake, { OBSERVE_TIMEOUT_MINUTES: "1", OBSERVE_POLL_SECONDS: "30" }));
    expect(out.parts[0]!.outcome).toBe("not-observed");
    expect(fake.issues.get(12)!.state).toBe("open");
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

  it("only links console.cloud.google.com URLs", async () => {
    const fake = new Fake();
    fake.builds.push({ id: "build-1", trigger: "deploy-web", statuses: ["FAILURE"], logUrl: "https://evil.example/x" });
    fake.pulls.push(factoryPull(30, 12));
    fake.issue(12);
    await observeStep(deps(fake));
    expect(fake.commentsOn(30)[0]!.body).toBe(`❌ Cloud Build \`build-1\` failed (FAILURE)\n${releaseMarker(SHA)}`);

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
        `[Build details](${LOG_URL})`,
        "**api:** ❌ Cloud Build `build-api` failed (FAILURE)",
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

describe("factoryIssue", () => {
  const pr = (ref: string, repo: string | null = REPO) => factoryPull(1, 0, { head: { ref, repo: repo ? { full_name: repo } : null } });
  it("matches only factory/issue-<n> in this repo", () => {
    expect(factoryIssue(pr("factory/issue-12"), REPO)).toBe(12);
    expect(factoryIssue(pr("factory/issue-12", "mallory/demo"), REPO)).toBeUndefined();
    expect(factoryIssue(pr("factory/issue-12", null), REPO)).toBeUndefined();
    for (const ref of ["factory/issue-0", "factory/issue-012", "factory/issue-12x", "factory/issue-12345678", "xfactory/issue-1", "factory/issue-1/x"]) {
      expect(factoryIssue(pr(ref), REPO)).toBeUndefined();
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
