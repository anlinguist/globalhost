import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { inspectResultBundle } from "../src/git.js";

const BRANCH = "factory/issue-7";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env, encoding: "utf8" }).trim();

let dir: string;
let work: string;
let bare: string;
let base: string;

function commit(file: string, content: string): string {
  writeFileSync(join(work, file), content);
  git(work, "add", file);
  git(work, "commit", "-q", "-m", `edit ${file}`);
  return git(work, "rev-parse", "HEAD");
}

function bundle(name: string, ...refs: string[]): string {
  const path = join(dir, name);
  git(work, "bundle", "create", "-q", path, ...refs);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-git-"));
  work = join(dir, "work");
  git(dir, "init", "-q", "-b", "main", work);
  commit("README.md", "hello\n");
  base = commit("app.ts", "export const x = 1;\n");
  bare = join(dir, "base.git");
  git(dir, "clone", "-q", "--bare", work, bare);
});

describe("inspectResultBundle", () => {
  it("accepts a branch on top of the base and lists what changed", async () => {
    git(work, "checkout", "-q", "-b", BRANCH);
    commit("app.ts", "export const x = 2;\n");
    const head = commit("app.test.ts", "test\n");
    const summary = await inspectResultBundle(bare, bundle("ok.bundle", BRANCH, `^${base}`), base, BRANCH);
    expect(summary).toMatchObject({ branch: BRANCH, headSha: head, commits: 2, filesChanged: ["app.test.ts", "app.ts"] });
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a bundle without the expected branch", async () => {
    git(work, "checkout", "-q", "-b", "other");
    commit("app.ts", "y\n");
    await expect(inspectResultBundle(bare, bundle("b.bundle", "other", `^${base}`), base, BRANCH)).rejects.toThrow(/no refs\/heads\/factory\/issue-7/);
  });

  it("rejects extra refs, such as a rewritten main", async () => {
    git(work, "checkout", "-q", "-b", BRANCH);
    commit("app.ts", "y\n");
    git(work, "checkout", "-q", "main");
    commit("evil.ts", "z\n");
    await expect(inspectResultBundle(bare, bundle("b.bundle", BRANCH, "main", `^${base}`), base, BRANCH)).rejects.toThrow(/unexpected refs: refs\/heads\/main/);
  });

  it("rejects a branch that doesn't descend from the base", async () => {
    git(work, "checkout", "-q", "--orphan", BRANCH);
    commit("app.ts", "rewritten\n");
    await expect(inspectResultBundle(bare, bundle("b.bundle", BRANCH), base, BRANCH)).rejects.toThrow(/does not descend/);
  });

  it("rejects an empty branch", async () => {
    git(work, "branch", BRANCH);
    git(work, "checkout", "-q", BRANCH);
    commit("x", "1\n");
    git(work, "reset", "-q", "--hard", base);
    await expect(inspectResultBundle(bare, bundle("b.bundle", BRANCH), base, BRANCH)).rejects.toThrow(/no commits/);
  });

  it("rejects a bundle whose prerequisites are missing from the base repo", async () => {
    git(work, "checkout", "-q", "-b", BRANCH);
    const unknown = commit("a", "1\n");
    commit("b", "2\n");
    await expect(inspectResultBundle(bare, bundle("b.bundle", BRANCH, `^${unknown}`), base, BRANCH)).rejects.toThrow();
  });

  it("rejects garbage", async () => {
    const path = join(dir, "junk.bundle");
    writeFileSync(path, "# v2 git bundle\nnot really\n");
    await expect(inspectResultBundle(bare, path, base, BRANCH)).rejects.toThrow();
  });
});
