// Repo in, result out, as git bundles (ADR-0011): the session never gets a GitHub credential.
// The result bundle is agent output, so it's untrusted: git only ever fetches it into a bare repo
// (no checkout, no hooks), and the harness checks its shape before anything uses it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoSnapshot } from "@globalhost/core";
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

export interface ReviewBundle extends RepoBundle {
  /** Tip of the base branch when the bundle was made. */
  baseSha: string;
  /** The PR head, checked against the SHA the caller asked to review. */
  headSha: string;
  /** `git merge-base` of base and head: the reviewer diffs merge-base..head, as GitHub shows the PR. */
  mergeBaseSha: string;
  baseBranch: string;
  /** The branch in the bundle that holds the head; the bundle's HEAD points at it. */
  headBranch: string;
}

export interface ReviewBundleRequest {
  baseBranch: string;
  pr: number;
  /** The head SHA the caller decided to review (e.g. the CI run's head). A PR that moved since is refused. */
  headSha: string;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;
export const reviewHeadBranch = (pr: number) => `globalhost-review/pr-${pr}`;

const CREDENTIAL_KEY = /(^|\.)(extraheader|credential|askpass|password|token)(\.|$)|^credential\./i;
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i;

/**
 * Throws if the repo's own config holds anything credential-shaped: an http extra header, a credential helper,
 * or a remote URL with userinfo. The token is only ever passed through git's environment; this checks that
 * nothing persisted it.
 */
export async function assertNoStoredCredentials(repoDir: string): Promise<void> {
  const listed = await git(["config", "--local", "--list", "-z"], { cwd: repoDir });
  for (const entry of listed.split("\0").filter(Boolean)) {
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    if (CREDENTIAL_KEY.test(key)) throw new Error(`repo config holds a credential-like key: ${key}`);
    if (/^remote\..*\.(url|pushurl)$/i.test(key) && URL_USERINFO.test(value)) throw new Error(`remote URL in ${key} carries credentials`);
  }
}

/**
 * Bundles a PR for review: the base branch and the PR head (`refs/pull/<n>/head`), full history, no tags, with
 * HEAD on the head so `git clone` of the bundle checks it out and the reviewer can diff and revert against the
 * base. The token, if any, is a read-only one used only for this fetch; nothing in the bundle or the bare repo's
 * config carries it, and it never reaches the session.
 */
export async function createReviewBundle(cloneUrl: string, req: ReviewBundleRequest, token?: string): Promise<ReviewBundle> {
  if (!CLONE_URL.test(cloneUrl)) throw new Error(`unexpected clone URL: ${cloneUrl}`);
  return bundleReviewFrom(cloneUrl, req, token);
}

/**
 * createReviewBundle without the GitHub URL check, so tests can bundle from a local repository. Trusted callers
 * only: `source` is passed to git as a remote.
 */
export async function bundleReviewFrom(source: string, req: ReviewBundleRequest, token?: string): Promise<ReviewBundle> {
  const { baseBranch, pr, headSha } = req;
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error(`bad PR number: ${pr}`);
  if (!FULL_SHA.test(headSha)) throw new Error("head SHA must be a full lowercase hex commit ID");
  if (!BRANCH.test(baseBranch)) throw new Error(`unexpected base branch name: ${baseBranch}`);
  const headBranch = reviewHeadBranch(pr);
  if (baseBranch === headBranch) throw new Error(`base branch collides with ${headBranch}`);
  await git(["check-ref-format", `refs/heads/${baseBranch}`]);

  const dir = await mkdtemp(join(tmpdir(), "globalhost-review-"));
  try {
    return await bundleReviewInto(dir, source, req, headBranch, token);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function bundleReviewInto(
  dir: string,
  source: string,
  { baseBranch, pr, headSha }: ReviewBundleRequest,
  headBranch: string,
  token: string | undefined,
): Promise<ReviewBundle> {
  const bareDir = join(dir, "repo.git");
  await git(["clone", "--quiet", "--bare", "--single-branch", "--no-tags", "--branch", baseBranch, "--", source, bareDir], {
    token,
  });
  await git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", source, `+refs/pull/${pr}/head:refs/heads/${headBranch}`], {
    cwd: bareDir,
    token,
  });
  await assertNoStoredCredentials(bareDir);
  const fetchedHead = (await git(["rev-parse", "--verify", `refs/heads/${headBranch}^{commit}`], { cwd: bareDir })).trim();
  if (fetchedHead !== headSha) {
    throw new Error(`PR #${pr} head is ${fetchedHead.slice(0, 12)}, not ${headSha.slice(0, 12)}: it moved since the review was requested`);
  }
  const baseSha = (await git(["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`], { cwd: bareDir })).trim();
  let mergeBaseSha: string;
  try {
    mergeBaseSha = (await git(["merge-base", baseSha, headSha], { cwd: bareDir })).trim();
  } catch {
    throw new Error(`PR #${pr} head shares no history with ${baseBranch}`);
  }
  await git(["symbolic-ref", "HEAD", `refs/heads/${headBranch}`], { cwd: bareDir });
  const bundlePath = join(dir, "repo.bundle");
  await git(["bundle", "create", "--quiet", bundlePath, "HEAD", `refs/heads/${headBranch}`, `refs/heads/${baseBranch}`], { cwd: bareDir });
  return { bareDir, bundlePath, baseSha, headSha, mergeBaseSha, baseBranch, headBranch };
}

/** Larger blobs read as absent: toolchain detection only needs version files and manifests. */
export const MAX_SNAPSHOT_BLOB_BYTES = 512 * 1024;
const MAX_SNAPSHOT_FILES = 200_000;

/**
 * A read-only RepoSnapshot of one commit in a (bare) repo, read from git objects: the tree's regular files only
 * (no symlinks or submodules), each blob read once, larger than MAX_SNAPSHOT_BLOB_BYTES or not UTF-8 → absent.
 * Used to resolve the toolchain at the run's base commit, so nothing on a PR head can change it.
 */
export async function gitSnapshot(repoDir: string, commit: string): Promise<RepoSnapshot> {
  if (!FULL_SHA.test(commit)) throw new Error("snapshot commit must be a full lowercase hex commit ID");
  const listing = await git(["ls-tree", "-r", "-z", "--full-tree", "-l", commit], { cwd: repoDir });
  const blobs = new Map<string, { object: string; size: number }>();
  for (const entry of listing.split("\0")) {
    // <mode> SP <type> SP <object> SP+ <size> TAB <path>
    const m = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+)\t(.+)$/s.exec(entry);
    if (!m?.[2] || !m[3] || !m[4]) continue;
    blobs.set(m[4], { object: m[2], size: Number(m[3]) });
    if (blobs.size > MAX_SNAPSHOT_FILES) throw new Error(`commit ${commit.slice(0, 12)} has too many files to snapshot`);
  }
  const cache = new Map<string, Promise<string | undefined>>();
  const read = async (path: string): Promise<string | undefined> => {
    const blob = blobs.get(path);
    if (!blob || blob.size > MAX_SNAPSHOT_BLOB_BYTES) return undefined;
    const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", "cat-file", "blob", blob.object], {
      cwd: repoDir,
      env: gitEnv(),
      encoding: "buffer",
      maxBuffer: MAX_SNAPSHOT_BLOB_BYTES + 1,
    });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    } catch {
      return undefined;
    }
  };
  return {
    files: [...blobs.keys()],
    readFile: (path) => {
      let hit = cache.get(path);
      if (!hit) cache.set(path, (hit = read(path)));
      return hit;
    },
  };
}

/**
 * Checks the agent's result bundle: it must carry exactly `refs/heads/<branch>`, its prerequisites
 * must be in the base repo, and the branch must descend from the base commit. Returns what changed, in any commit.
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
  // Every path any commit touched, not the net diff: the push carries each commit, so a file added and then deleted
  // still reaches the branch. Rename detection stays off so a move reports the path it left too.
  const touched = await git(["log", "--no-renames", "--diff-merges=separate", "--name-only", "-z", "--format=", `${baseSha}..${headSha}`], { cwd: bareDir });
  const filesChanged = [...new Set(touched.split("\0").filter(Boolean))].sort();

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
