// Repo in, result out, as git bundles (ADR-0011): the session never gets a GitHub credential.
// The result bundle is agent output, so it's untrusted: git only ever fetches it into a bare repo
// (no checkout, no hooks), and the harness checks its shape before anything uses it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BundleSummary } from "./records.js";

const run = promisify(execFile);

const MAX_COMMITS = 200;

/** A minimal git environment: no prompts, no user or system config, and optionally one auth header. */
function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (token) {
    // Passed through the environment, not argv, so it doesn't show in process listings.
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    });
  }
  return env;
}

/** git with hooks off and no user or system config; exported for other trusted callers (assessments). */
export async function git(args: string[], opts: { cwd?: string; token?: string } = {}): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: opts.cwd,
    env: gitEnv(opts.token),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export interface RepoBundle {
  /** Bare clone of the default branch, kept for checking the result bundle against. */
  bareDir: string;
  bundlePath: string;
  baseSha: string;
}

const CLONE_URL = /^https:\/\/github\.com\/[^\s]+\.git$/;

/**
 * Bare-clones every branch (full history, no tags, no checkout), for read-only inspection such as a secret scan.
 * Returns the bare repo's directory; the caller removes its parent when done.
 */
export async function bareCloneAll(cloneUrl: string, token?: string): Promise<string> {
  if (!CLONE_URL.test(cloneUrl)) throw new Error(`unexpected clone URL: ${cloneUrl}`);
  const dir = await mkdtemp(join(tmpdir(), "globalhost-assess-"));
  const bareDir = join(dir, "repo.git");
  await git(["clone", "--quiet", "--bare", "--no-tags", "--", cloneUrl, bareDir], { token });
  return bareDir;
}

/** Bare-clones one branch and bundles it with HEAD set, so `git clone` of the bundle checks it out. */
export async function createRepoBundle(cloneUrl: string, branch: string, token?: string): Promise<RepoBundle> {
  if (!CLONE_URL.test(cloneUrl)) throw new Error(`unexpected clone URL: ${cloneUrl}`);
  const dir = await mkdtemp(join(tmpdir(), "globalhost-run-"));
  const bareDir = join(dir, "repo.git");
  await git(["clone", "--quiet", "--bare", "--single-branch", "--no-tags", "--branch", branch, "--", cloneUrl, bareDir], {
    token,
  });
  const baseSha = (await git(["rev-parse", `refs/heads/${branch}`], { cwd: bareDir })).trim();
  const bundlePath = join(dir, "repo.bundle");
  await git(["bundle", "create", "--quiet", bundlePath, "HEAD", `refs/heads/${branch}`], { cwd: bareDir });
  return { bareDir, bundlePath, baseSha };
}

/**
 * Checks the agent's result bundle: it must carry exactly `refs/heads/<branch>`, its prerequisites
 * must be in the base repo, and the branch must descend from the base commit. Returns what changed.
 */
export async function inspectResultBundle(
  bareDir: string,
  bundlePath: string,
  baseSha: string,
  branch: string,
): Promise<BundleSummary> {
  const ref = `refs/heads/${branch}`;
  const heads = (await git(["bundle", "list-heads", bundlePath], { cwd: bareDir }))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[1]);
  const extra = heads.filter((h) => h !== ref && h !== "HEAD");
  if (!heads.includes(ref)) throw new Error(`result bundle has no ${ref}`);
  if (extra.length > 0) throw new Error(`result bundle carries unexpected refs: ${extra.join(", ")}`);

  await git(["bundle", "verify", "--quiet", bundlePath], { cwd: bareDir });
  const local = "refs/globalhost/result";
  await git(["fetch", "--quiet", "--no-tags", "--force", bundlePath, `${ref}:${local}`], { cwd: bareDir });
  const headSha = (await git(["rev-parse", local], { cwd: bareDir })).trim();

  try {
    await git(["merge-base", "--is-ancestor", baseSha, headSha], { cwd: bareDir });
  } catch {
    throw new Error(`${branch} does not descend from the base commit ${baseSha.slice(0, 12)}`);
  }
  const commits = Number((await git(["rev-list", "--count", `${baseSha}..${headSha}`], { cwd: bareDir })).trim());
  if (commits === 0) throw new Error(`${branch} has no commits on top of the base`);
  if (commits > MAX_COMMITS) throw new Error(`${branch} has ${commits} commits (max ${MAX_COMMITS})`);
  const filesChanged = (await git(["diff", "--name-only", "-z", baseSha, headSha], { cwd: bareDir }))
    .split("\0")
    .filter(Boolean);

  const bytes = await readFile(bundlePath);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: (await stat(bundlePath)).size,
    branch,
    headSha,
    commits,
    filesChanged,
  };
}
