import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GcpFacts } from "@globalhost/assess";
import { webApp } from "@globalhost/profile-web-app";
import { GitHubReader } from "@globalhost/runner";
import { describe, expect, it } from "vitest";
// The runner's in-memory Managed Agents fake; nothing here reaches Anthropic.
import { FakeApi } from "../../runner/test/fake-api.js";
import { assessCommand, ownerAsks, proposeCloudBuildRelease, type AssessIo } from "../src/assess-command.js";

const ENV = {
  GLOBALHOST_LOCAL_SA: "globalhost-local@globalhost-factory.iam.gserviceaccount.com",
  ANTHROPIC_ORGANIZATION_ID: "o",
  ANTHROPIC_FEDERATION_RULE_ID: "r",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "s",
  ANTHROPIC_WORKSPACE_ID: "w",
};

function io(env: NodeJS.ProcessEnv = ENV, extra: Partial<AssessIo> = {}): AssessIo & { stdout: string; stderr: string } {
  const r = {
    stdout: "",
    stderr: "",
    env,
    cwd: mkdtempSync(join(tmpdir(), "assess-cli-")),
    out: (t: string) => void (r.stdout += t),
    err: (t: string) => void (r.stderr += t),
    ...extra,
  };
  return r;
}

describe("globalhost assess (arguments)", () => {
  it("prints usage on --help", async () => {
    const r = io();
    expect(await assessCommand(["assess", "--help"], r)).toBe(0);
    expect(r.stdout).toContain("globalhost assess <owner/repo>");
  });

  it.each([
    [["assess"], "expected <owner/repo>"],
    [["assess", "a/b", "c/d"], "expected <owner/repo>"],
    [["assess", "../etc"], "not an owner/name repo slug"],
    [["assess", "a/b", "--gcp-project=--impersonate-service-account=x"], "--gcp-project must be a GCP project id"],
    [["assess", "a/b", "--gcp-project", "X"], "--gcp-project must be a GCP project id"],
    [["assess", "a/b", "--owner", "anlinguist"], "--owner must be <login>:<user id>"],
    [["assess", "a/b", "--budget", "500"], "--budget must be a number"],
    [["assess", "a/b", "--post"], "--post needs GITHUB_TOKEN"],
    [["assess", "a/b", "--post-from", "x"], "--post needs GITHUB_TOKEN"],
    [["assess", "a/b", "--bogus"], "Unknown option"],
  ])("rejects %j with exit 2", async (argv, message) => {
    const r = io();
    expect(await assessCommand(argv, r)).toBe(2);
    expect(r.stderr).toContain(message);
  });

  it("needs the keyless-auth service account like globalhost run", async () => {
    const r = io({});
    expect(await assessCommand(["assess", "anlinguist/numu-know"], r)).toBe(2);
    expect(r.stderr).toContain("GLOBALHOST_LOCAL_SA is not set");
  });
});

describe("ownerAsks", () => {
  it("takes only the open-items section of ADR-0005", () => {
    const adr = readFileSync(new URL("../../../docs/decisions/0005-first-profile-and-pilot.md", import.meta.url), "utf8");
    const asks = ownerAsks(adr);
    expect(asks).toMatch(/^- Branch flow:/);
    expect(asks).toContain("numu-know-dev");
    expect(asks).toContain("Firebase Auth authorized domains");
    expect(asks).not.toContain("## Decision");
  });

  it("uses a whole file without such a heading", () => {
    expect(ownerAsks("\n- one\n- two\n")).toBe("- one\n- two");
  });
});

describe("proposeCloudBuildRelease", () => {
  const gcp = (items: { name: string; pushBranch?: string; disabled?: boolean; repo?: string }[]): GcpFacts => ({
    project: "numu-know",
    triggers: { ok: true, truncated: false, items: items.map((t, i) => ({ id: `id-${i}`, disabled: false, ...t })) },
    services: { ok: true, items: [], truncated: false },
    firestore: { ok: true, items: [], truncated: false },
  });
  const ctx = (g: GcpFacts | undefined) => ({
    profile: webApp as never,
    part: { path: ".", profile: "web-app", confidence: 1, evidence: [], suggestedConfig: {} },
    gcp: g,
    repo: "anlinguist/numu-know",
    defaultBranch: "main",
  });

  it("keeps the one enabled trigger that builds the default branch of this repo", () => {
    const g = gcp([
      { name: "numu-know-main", pushBranch: "^main$", repo: "anlinguist/numu-know" },
      { name: "staging-numu-know", pushBranch: "^staging$", repo: "anlinguist/numu-know" },
      { name: "other-repo", pushBranch: "^main$", repo: "anlinguist/other" },
      { name: "old", pushBranch: ".*", disabled: true },
    ]);
    expect(proposeCloudBuildRelease(ctx(g))).toEqual({ adapter: "cloud-build-trigger", config: { project: "numu-know", trigger: "numu-know-main" } });
  });

  it("proposes nothing when it's ambiguous, unknown, or the regex is invalid", () => {
    expect(proposeCloudBuildRelease(ctx(undefined))).toBeUndefined();
    expect(proposeCloudBuildRelease(ctx(gcp([{ name: "a", pushBranch: "^main$" }, { name: "b", pushBranch: "ma.*" }])))).toBeUndefined();
    expect(proposeCloudBuildRelease(ctx(gcp([{ name: "a", pushBranch: "(" }])))).toBeUndefined();
  });
});

describe("globalhost assess (end to end with fakes)", () => {
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();
  const fixture = (name: string) => (JSON.parse(readFileSync(new URL(`../../assess/test/fixtures/${name}`, import.meta.url), "utf8")) as { body: unknown }).body;
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "numu-know", scripts: { build: "next build" }, dependencies: { next: "16.0.0" } }),
    "app/page.tsx": "export default function Page() {}\n",
  };

  function world(env: NodeJS.ProcessEnv) {
    const root = mkdtempSync(join(tmpdir(), "assess-cli-repo-"));
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "main", work);
    for (const [p, c] of Object.entries(FILES)) {
      mkdirSync(join(work, p, ".."), { recursive: true });
      writeFileSync(join(work, p), c);
    }
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "init");
    const sha = git(work, "rev-parse", "HEAD");
    const bare = () => {
      const dir = join(mkdtempSync(join(tmpdir(), "assess-cli-clone-")), "repo.git");
      git(root, "clone", "-q", "--bare", work, dir);
      return dir;
    };

    const routes: Record<string, { status?: number; body: unknown }> = {
      "GET /repos/anlinguist/numu-know": { body: fixture("rest/repo.json") },
      "GET /repos/anlinguist/numu-know/actions/workflows?per_page=100": { body: fixture("rest/workflows.json") },
      "GET /repos/anlinguist/numu-know/contributors?per_page=100": { body: fixture("rest/contributors.json") },
      [`GET /repos/anlinguist/numu-know/git/trees/${sha}?recursive=1`]: {
        body: { truncated: false, tree: Object.entries(FILES).map(([path, c]) => ({ path, type: "blob", size: c.length })) },
      },
      "POST /repos/anlinguist/numu-know/issues": { status: 201, body: { number: 7, html_url: "https://github.com/anlinguist/numu-know/issues/7" } },
    };
    for (const [p, c] of Object.entries(FILES)) {
      routes[`GET /repos/anlinguist/numu-know/contents/${p}?ref=${sha}`] = { body: { content: Buffer.from(c).toString("base64"), encoding: "base64" } };
    }
    const calls: { method: string; path: string; auth?: string; body?: { title: string; body: string } }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com", "");
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, path, auth: headers.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes[`${method} ${path}`];
      return r ? Response.json(r.body, { status: r.status ?? 200 }) : new Response("{}", { status: 404 });
    }) as typeof fetch;

    const api = new FakeApi();
    api.onSend = () => {
      const id = [...api.sessions.keys()].at(-1)!;
      const at = new Date().toISOString();
      const files = {
        "report.json": JSON.stringify({ outcome: "done", summary: "Assessed.", readiness: [{ id: "build", points: 15, evidence: "next build passed" }] }),
        "assessment.md": "## Stack & parts\n\nA Next.js app. <!-- approve me --> ping @anlinguist\n",
      };
      for (const [filename, data] of Object.entries(files)) {
        api.outputs.push({ id: filename, filename, sizeBytes: data.length, createdAt: at, data: Buffer.from(data) });
      }
      api.finishTurn(id, "end_turn", 80);
    };

    const r = io(env, {
      api,
      fetchImpl,
      github: new GitHubReader(undefined, fetchImpl),
      skillDirs: [],
      exec: async (file) => {
        throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
      },
      cloneAll: async () => bare(),
      cloneRepo: async () => {
        const bareDir = bare();
        const bundlePath = join(bareDir, "..", "repo.bundle");
        git(bareDir, "bundle", "create", "-q", bundlePath, "HEAD", "refs/heads/main");
        return { bareDir, bundlePath, baseSha: sha };
      },
    });
    return { r, api, calls };
  }

  it("dry run: writes assessment.md and run.json, posts nothing, and prints how to post", async () => {
    const { r, api, calls } = world(ENV);
    expect(await assessCommand(["assess", "anlinguist/numu-know", "--out", "out"], r)).toBe(0);
    const out = join(r.cwd, "out");
    const body = readFileSync(join(out, "assessment.md"), "utf8");
    expect(body).toContain("## Risks & asks");
    expect(body).toContain("A Next.js app.");
    expect(body).not.toContain("<!--");
    expect(JSON.parse(readFileSync(join(out, "run.json"), "utf8"))).toMatchObject({ role: "assessor", issue: null, status: "succeeded" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(r.stdout).toContain(`issue     ${join(out, "assessment.md")}`);
    expect(r.stdout).toContain("--post-from");
    expect(r.stdout).toMatch(/readiness \d+\/100/);
    // The assessor's agent got no credential.
    expect(api.sent[0]).not.toMatch(/gh[pousr]_|github_pat_|Authorization|owner-token/i);
  });

  it("--post opens the issue with the owner's token, which the session never sees", async () => {
    const { r, api, calls } = world({ ...ENV, GITHUB_TOKEN: "owner-token" });
    expect(await assessCommand(["assess", "anlinguist/numu-know", "--post"], r)).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: "/repos/anlinguist/numu-know/issues", auth: "Bearer owner-token" });
    expect(posts[0]!.body!.title).toBe("globalhost onboarding assessment: anlinguist/numu-know");
    expect(posts[0]!.body!.body).not.toMatch(/@[A-Za-z0-9-]/);
    expect(r.stdout).toContain("posted    https://github.com/anlinguist/numu-know/issues/7");
    expect(JSON.stringify([...api.sessions.values()].map((s) => s.spec))).not.toContain("owner-token");
    expect(api.sent.join("\n")).not.toContain("owner-token");
  });

  it("--post-from posts a reviewed dry run without running anything, still neutralized", async () => {
    const { r, api, calls } = world({ ...ENV, GITHUB_TOKEN: "owner-token" });
    mkdirSync(join(r.cwd, "reviewed"));
    writeFileSync(join(r.cwd, "reviewed", "assessment.md"), "Edited by the owner. <!-- hidden --> cc @someone\n");
    expect(await assessCommand(["assess", "anlinguist/numu-know", "--post-from", "reviewed"], r)).toBe(0);
    expect(api.sessions.size).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body!.body).toBe("Edited by the owner. &lt;!-- hidden --> cc @‍someone\n");
  });
});
