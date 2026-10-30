// A fake GitHub REST API and GCS bucket store behind one fetch, recording every call.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, z, type AdapterDescriptor, type ProfileDescriptor } from "@globalhost/core";

export const OWNER = { login: "anlinguist", id: 47403803, type: "User" };
export const STRANGER = { login: "mallory", id: 666, type: "User" };
export const BOT = { login: "globalhost-ai[bot]", id: 9000, type: "Bot" };
export const REPO = "anlinguist/demo";

const webApp: ProfileDescriptor = {
  id: "web-app",
  configSchema: z.object({}).passthrough(),
  preview: { kinds: ["url"], outputs: ["url"], inputs: [] },
  release: { allowedAdapters: [] },
};
const adapter: AdapterDescriptor = { id: "cloud-build-trigger", configSchema: z.object({}).passthrough() };
export const registry = createRegistry([webApp], [adapter]);

export const FACTORY_YAML = `version: 1
product: demo
owners:
  - { login: anlinguist, id: 47403803 }
parts:
  web: { path: ., profile: web-app, preview: { enabled: false } }
limits: { perRunUsd: 2, dailyUsd: 5 }
guardrails:
  loadBearing: ["proxy.ts"]
`;

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export class FakeCloud {
  calls: Call[] = [];
  routes = new Map<string, unknown>();
  objects = new Map<string, { body: string; generation: number }>();
  comments: { issue: number; body: string }[] = [];
  labels = new Map<number, Set<string>>();
  pulls: { number: number; head: string; base: string; title: string; draft: boolean }[] = [];
  private gen = 1;

  constructor(factoryYaml = FACTORY_YAML) {
    this.routes.set(`GET /repos/${REPO}`, { default_branch: "main" });
    this.routes.set(`GET /repos/${REPO}/contents/factory.yaml?ref=main`, {
      content: Buffer.from(factoryYaml).toString("base64"),
      encoding: "base64",
    });
  }

  fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? safeJson(init.body) : init.body;
    if (url.host === "storage.googleapis.com") return this.gcs(url, method, init);
    const path = `${url.pathname}${url.search}`;
    this.calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (this.routes.has(key)) return Response.json(this.routes.get(key));

    let m: RegExpExecArray | null;
    if (method === "POST" && (m = /\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
      this.comments.push({ issue: Number(m[1]), body: (body as { body: string }).body });
      return Response.json({ id: this.comments.length }, { status: 201 });
    }
    if (method === "GET" && (m = /\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
      return Response.json(
        this.comments.filter((c) => c.issue === Number(m![1])).map((c, i) => ({ id: i + 1, body: c.body, user: BOT })),
      );
    }
    if (method === "POST" && (m = /\/issues\/(\d+)\/labels$/.exec(url.pathname))) {
      const set = this.labels.get(Number(m[1])) ?? new Set();
      for (const l of (body as { labels: string[] }).labels) set.add(l);
      this.labels.set(Number(m[1]), set);
      return Response.json([]);
    }
    if (method === "DELETE" && (m = /\/issues\/(\d+)\/labels\/(.+)$/.exec(url.pathname))) {
      const removed = this.labels.get(Number(m[1]))?.delete(decodeURIComponent(m[2]!));
      return removed ? new Response(null, { status: 204 }) : new Response("{}", { status: 404 });
    }
    if (method === "GET" && url.pathname === `/repos/${REPO}/pulls` && url.searchParams.get("head")) {
      return Response.json([]);
    }
    if (method === "POST" && url.pathname === `/repos/${REPO}/pulls`) {
      const b = body as { head: string; base: string; title: string; draft: boolean };
      const pr = { number: 100 + this.pulls.length, ...b };
      this.pulls.push(pr);
      return Response.json(
        { number: pr.number, state: "open", draft: true, head: { ref: b.head, repo: { full_name: REPO } }, base: { ref: b.base }, html_url: "https://x" },
        { status: 201 },
      );
    }
    if (method === "GET" && url.pathname.startsWith(`/repos/${REPO}/branches/`)) return new Response("{}", { status: 404 });
    return new Response(`no route for ${key}`, { status: 404 });
  }) as typeof fetch;

  private gcs(url: URL, method: string, init: RequestInit): Response {
    if (url.pathname.startsWith("/upload/")) {
      const name = `${url.pathname.split("/")[5]}/${url.searchParams.get("name")}`;
      const cur = this.objects.get(name);
      const match = url.searchParams.get("ifGenerationMatch");
      if (match !== null && String(cur?.generation ?? 0) !== match) return new Response("", { status: 412 });
      const body = typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf8");
      this.objects.set(name, { body, generation: ++this.gen });
      return Response.json({});
    }
    const [, , , , bucket, , encoded] = url.pathname.split("/");
    const name = `${bucket}/${decodeURIComponent(encoded ?? "")}`;
    const cur = this.objects.get(name);
    if (method === "DELETE") {
      if (!cur || String(cur.generation) !== url.searchParams.get("ifGenerationMatch")) return new Response("", { status: 412 });
      this.objects.delete(name);
      return new Response(null, { status: 204 });
    }
    if (!cur) return new Response("", { status: 404 });
    if (url.searchParams.get("alt") === "media") return new Response(cur.body);
    return Response.json({ generation: String(cur.generation) });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();

/** A work repo, a bare "GitHub" remote, and a helper to produce result bundles touching given files. */
export function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
  const work = join(dir, "work");
  git(dir, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "app.ts"), "export const x = 1;\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  const baseSha = git(work, "rev-parse", "HEAD");
  const remote = join(dir, "remote.git");
  git(dir, "clone", "-q", "--bare", work, remote);

  const baseClone = () => {
    const bareDir = join(mkdtempSync(join(tmpdir(), "dispatch-base-")), "repo.git");
    git(dir, "clone", "-q", "--bare", remote, bareDir);
    return { bareDir, bundlePath: join(bareDir, "..", "repo.bundle"), baseSha };
  };

  const resultBundle = (outDir: string, issue: number, files: Record<string, string>) => {
    const branch = `factory/issue-${issue}`;
    git(work, "checkout", "-q", "-B", branch, baseSha);
    for (const [f, content] of Object.entries(files)) {
      execFileSync("mkdir", ["-p", join(work, f, "..")]);
      writeFileSync(join(work, f), content);
    }
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "change");
    git(work, "bundle", "create", "-q", join(outDir, "result.bundle"), branch, `^${baseSha}`);
    git(work, "checkout", "-q", "main");
    return git(work, "rev-parse", branch);
  };
  return { dir, work, remote, baseSha, baseClone, resultBundle };
}
