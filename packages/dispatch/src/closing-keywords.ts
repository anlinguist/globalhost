// GitHub closes an issue when a commit landing on the default branch (or a squash message, or a PR title
// that becomes one) says "fixes #n". Factory issues must close only once the merge deploys (P1-12), so the
// publisher rewrites closing keywords in agent commits and in the PR title to "refs" before pushing.
//
// The commits are agent-written and may be crafted, so the rewrite fails closed on anything unusual in the
// raw object and proves afterwards that every rewritten commit has exactly the tree git (and so the path
// policy) saw.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const NAME = "[A-Za-z0-9_.-]+";
/** What GitHub links as an issue: #n, GH-n, owner/repo#n, or an issues/pull URL. */
const ISSUE_REF = String.raw`(?:#\d|GH-\d|${NAME}\/${NAME}#\d|https?:\/\/(?:www\.)?github\.com\/${NAME}\/${NAME}\/(?:issues|pull)\/\d)`;
// Over-matches on purpose (no word boundary needed after the keyword, any whitespace, optional colon).
// The separator is linear: one whitespace run, then optionally a colon and another run.
const CLOSING = new RegExp(String.raw`(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*(?::\s*)?)(?=${ISSUE_REF})`, "gi");

/** Commit messages longer than this are refused rather than scanned. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Replaces every closing keyword that precedes an issue reference with "refs". */
export function neutralizeClosingKeywords(text: string): string {
  return text.replace(CLOSING, "refs$1");
}

export const hasClosingKeyword = (text: string): boolean => neutralizeClosingKeywords(text) !== text;

export class UnsafeCommitError extends Error {
  constructor(sha: string, reason: string) {
    super(`refusing to publish commit ${sha.slice(0, 12)}: ${reason}`);
    this.name = "UnsafeCommitError";
  }
}

const gitEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  ...extra,
});

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: gitEnv(),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: gitEnv(extraEnv), maxBuffer: 64 * 1024 * 1024 })).stdout;
}

const treeOf = async (cwd: string, rev: string) => (await git(cwd, ["rev-parse", "--verify", `${rev}^{tree}`])).trim();

const IDENT = /^(author|committer) ([^<>\n]*) <([^<>\n]*)> (\d{1,15}) ([+-]\d{4})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface Parsed {
  sha: string;
  parents: string[];
  message: string;
  env: Record<string, string>;
}

/** Parses one raw commit object, refusing anything a rewrite couldn't reproduce faithfully. */
function parseCommit(sha: string, parents: string[], raw: Buffer): Parsed {
  if (raw.includes(0)) throw new UnsafeCommitError(sha, "NUL byte in the commit object");
  const split = raw.indexOf("\n\n");
  const headerBytes = split === -1 ? raw : raw.subarray(0, split);
  const messageBytes = split === -1 ? Buffer.alloc(0) : raw.subarray(split + 2);
  if (messageBytes.length > MAX_MESSAGE_BYTES) throw new UnsafeCommitError(sha, `message is over ${MAX_MESSAGE_BYTES} bytes`);
  let headers: string;
  let message: string;
  try {
    headers = utf8.decode(headerBytes);
    message = utf8.decode(messageBytes);
  } catch {
    throw new UnsafeCommitError(sha, "commit is not valid UTF-8");
  }
  const counts = { tree: 0, author: 0, committer: 0 };
  const env: Record<string, string> = {};
  for (const line of headers.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of a multi-line header (e.g. gpgsig)
    const key = line.slice(0, line.indexOf(" ") === -1 ? line.length : line.indexOf(" "));
    if (key === "encoding") throw new UnsafeCommitError(sha, "commit has an encoding header");
    if (key === "tree") counts.tree++;
    if (key === "author" || key === "committer") {
      counts[key]++;
      const m = IDENT.exec(line);
      if (!m) throw new UnsafeCommitError(sha, `malformed ${key} header`);
      const who = key === "author" ? "AUTHOR" : "COMMITTER";
      env[`GIT_${who}_NAME`] = m[2]!;
      env[`GIT_${who}_EMAIL`] = m[3]!;
      // "@<seconds> <tz>" is read as a raw timestamp, so even tiny values round-trip exactly.
      env[`GIT_${who}_DATE`] = `@${m[4]} ${m[5]}`;
    }
  }
  for (const [k, n] of Object.entries(counts)) if (n !== 1) throw new UnsafeCommitError(sha, `${n} ${k} headers`);
  return { sha, parents, message, env };
}

/**
 * Rewrites the commits in base..ref whose messages carry a closing keyword, keeping trees (as git parses
 * them), authors, committers and dates (signatures are dropped on rewritten commits), and moves `ref` to the
 * new head. `ref` must point at `verifiedHead`, the commit the path policy checked; the new head must have its
 * tree. Throws UnsafeCommitError (and leaves `ref` alone) on any commit it can't rewrite faithfully. Returns how
 * many messages changed.
 */
export async function rewriteClosingKeywords(bareDir: string, baseSha: string, ref: string, verifiedHead: string): Promise<number> {
  const current = (await git(bareDir, ["rev-parse", "--verify", ref])).trim();
  if (current !== verifiedHead) throw new UnsafeCommitError(current, `${ref} is not the verified head ${verifiedHead.slice(0, 12)}`);
  const verifiedTree = await treeOf(bareDir, verifiedHead);

  const lines = (await git(bareDir, ["rev-list", "--reverse", "--topo-order", "--parents", `${baseSha}..${verifiedHead}`])).split("\n").filter(Boolean);
  // Check every commit before writing anything.
  const commits: Parsed[] = [];
  for (const line of lines) {
    const [sha, ...parents] = line.split(" ") as [string, ...string[]];
    commits.push(parseCommit(sha, parents, await gitBytes(bareDir, ["cat-file", "commit", sha])));
  }

  const mapped = new Map<string, string>();
  let changed = 0;
  let tmp: string | undefined;
  try {
    for (const c of commits) {
      const fixed = neutralizeClosingKeywords(c.message);
      const newParents = c.parents.map((p) => mapped.get(p) ?? p);
      if (fixed === c.message && newParents.every((p, i) => p === c.parents[i])) continue;
      if (fixed !== c.message) changed++;
      const tree = await treeOf(bareDir, c.sha);
      tmp ??= await mkdtemp(join(tmpdir(), "globalhost-msg-"));
      const msgFile = join(tmp, "msg");
      await writeFile(msgFile, fixed);
      const created = (await git(bareDir, ["commit-tree", tree, ...newParents.flatMap((p) => ["-p", p]), "-F", msgFile], c.env)).trim();
      if ((await treeOf(bareDir, created)) !== tree) throw new UnsafeCommitError(c.sha, "rewritten commit's tree differs");
      mapped.set(c.sha, created);
    }
    const newHead = mapped.get(verifiedHead);
    if (newHead) {
      if ((await treeOf(bareDir, newHead)) !== verifiedTree) throw new UnsafeCommitError(verifiedHead, "rewritten head's tree differs from the verified tree");
      await git(bareDir, ["update-ref", ref, newHead, verifiedHead]);
    }
    return changed;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
