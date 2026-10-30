// Fixtures and fakes: recorded GitHub responses, a routed fetch, a scripted exec (no gcloud or gitleaks is ever
// spawned by these), and throwaway local git repos standing in for clones.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitHubClient } from "@globalhost/dispatch";
import type { Exec } from "../src/common.js";
import type { AssessmentFacts } from "../src/facts.js";

/** numu-know's recorded file list and manifest, as a RepoSnapshot (from the web-app profile's P1-03 fixture). */
export function numuKnowSnapshot() {
  const fx = JSON.parse(readFileSync(new URL("../../profiles/web-app/test/fixtures/numu-know.json", import.meta.url), "utf8")) as {
    files: string[];
    contents: Record<string, string>;
  };
  return { files: fx.files, readFile: async (p: string) => fx.contents[p] };
}

/** A complete AssessmentFacts for a public single-app repo with nothing found; tests override what they need. */
export function baseFacts(): AssessmentFacts {
  const web = { path: ".", profile: "web-app", confidence: 0.97, evidence: ["package.json depends on next"], suggestedConfig: { port: 8080, routes: ["/", "/learn"], previewEnv: {} } };
  return {
    version: 1,
    gatheredAt: "2026-10-30T12:00:00.000Z",
    github: {
      repo: "anlinguist/numu-know",
      visibility: "public",
      defaultBranch: "main",
      archived: false,
      fork: false,
      pushedAt: "2026-01-17T21:30:23Z",
      cloneUrl: "https://github.com/anlinguist/numu-know.git",
      owner: { login: "anlinguist", id: 47403803, type: "User" },
      workflows: { ok: true, items: [], truncated: false },
      contributors: { ok: true, items: [{ login: "anlinguist", id: 47403803, type: "User", contributions: 17 }], truncated: false },
      collaborators: { ok: false, reason: "needs a token with push access" },
      outsideContributors: { ok: false, reason: "needs the collaborator list" },
    },
    branches: {
      defaultBranch: "main",
      defaultSha: "d9520f99a4f8c9e80eff56cc80d733c4bfe504b7",
      others: {
        ok: true,
        truncated: false,
        items: [
          { name: "staging", sha: "d9520f99a4f8c9e80eff56cc80d733c4bfe504b7", lastCommitAt: "2026-01-17T21:30:23+00:00", ahead: 0, behind: 0 },
          { name: "develop", sha: "1".repeat(40), lastCommitAt: "2025-06-01T00:00:00+00:00", ahead: 0, behind: 10 },
        ],
      },
    },
    stack: { candidates: [web], proposed: [web], lowConfidence: false },
    tests: { count: 0, sample: [] },
    docs: { agentDocs: [], readme: true },
    secrets: { gitleaks: { status: "ran", version: "8.30.1", findings: [], truncated: false }, credentialFiles: [], serviceAccountKeys: [] },
  };
}

export function fixture<T = unknown>(name: string): T {
  return (JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { body: T }).body;
}
export function rawFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export interface Route {
  status?: number;
  body: unknown;
}

/** A GitHubClient whose fetch serves `METHOD path` routes and records every request. */
export function fakeGitHub(routes: Record<string, Route | unknown>, token?: string) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const r = routes[key] as Route;
    const route = typeof r === "object" && r !== null && "body" in r ? r : { body: r };
    return Response.json(route.body, { status: route.status ?? 200 });
  }) as typeof fetch;
  return { gh: new GitHubClient(token, fetchImpl), fetchImpl, calls };
}

/** Routes for the recorded anonymous numu-know responses. */
export function numuKnowRoutes(): Record<string, unknown> {
  return {
    "GET /repos/anlinguist/numu-know": fixture("rest/repo.json"),
    "GET /repos/anlinguist/numu-know/actions/workflows?per_page=100": fixture("rest/workflows.json"),
    "GET /repos/anlinguist/numu-know/contributors?per_page=100": fixture("rest/contributors.json"),
    "GET /repos/anlinguist/numu-know/collaborators?per_page=100&affiliation=all": { status: 401, body: fixture("rest/collaborators-401.json") },
  };
}

/** Tree + contents routes serving `files` at any ref, as githubSnapshot reads them. */
export function snapshotRoutes(repo: string, ref: string, files: Record<string, string>): Record<string, unknown> {
  const routes: Record<string, unknown> = {
    [`GET /repos/${repo}/git/trees/${ref}?recursive=1`]: {
      truncated: false,
      tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: Buffer.byteLength(text) })),
    },
  };
  for (const [path, text] of Object.entries(files)) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    routes[`GET /repos/${repo}/contents/${encoded}?ref=${ref}`] = { content: Buffer.from(text).toString("base64"), encoding: "base64" };
  }
  return routes;
}

export interface ExecCall {
  file: string;
  args: readonly string[];
}

/** An Exec that answers from a script keyed by "file arg0 arg1 …" prefixes; anything unscripted is ENOENT. */
export function fakeExec(script: (call: ExecCall) => { stdout?: string; stderr?: string; error?: { code?: string | number; stderr?: string } } | undefined) {
  const calls: ExecCall[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    const r = script({ file, args });
    if (!r) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    if (r.error) throw Object.assign(new Error("failed"), r.error);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, encoding: "utf8" }).trim();

/** A work repo with `commits` applied in order (path → content, or null to delete), then a bare clone of it. */
export function localRepo(commits: Record<string, string | null>[], branches: Record<string, Record<string, string>> = {}) {
  const root = mkdtempSync(join(tmpdir(), "assess-repo-"));
  const work = join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  for (const [i, files] of commits.entries()) {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) git(work, "rm", "-q", path);
      else {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
        git(work, "add", path);
      }
    }
    git(work, "commit", "-q", "--allow-empty", "-m", `commit ${i}`);
  }
  for (const [name, files] of Object.entries(branches)) {
    git(work, "checkout", "-q", "-b", name);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
      git(work, "add", path);
    }
    git(work, "commit", "-q", "-m", `on ${name}`);
    git(work, "checkout", "-q", "main");
  }
  /** A fresh bare clone in its own temp dir (the caller removes the parent, as with bareCloneAll). */
  const clone = () => {
    const bare = join(mkdtempSync(join(tmpdir(), "assess-clone-")), "repo.git");
    git(root, "clone", "-q", "--bare", work, bare);
    return bare;
  };
  return { root, work, clone, sha: (ref = "main") => git(work, "rev-parse", ref) };
}
