// GitHub closes an issue when a commit landing on the default branch (or a squash message, or a PR title
// that becomes one) says "fixes #n". Factory issues must close only once the merge deploys (P1-12), so the
// publisher rewrites closing keywords in agent commits and in the PR title to "refs" before pushing.
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
const CLOSING = new RegExp(String.raw`(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s*)(?=${ISSUE_REF})`, "gi");

/** Replaces every closing keyword that precedes an issue reference with "refs". */
export function neutralizeClosingKeywords(text: string): string {
  return text.replace(CLOSING, "refs$1");
}

export const hasClosingKeyword = (text: string): boolean => neutralizeClosingKeywords(text) !== text;

const gitEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  ...extra,
});

async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: gitEnv(extraEnv), maxBuffer: 64 * 1024 * 1024 })).stdout;
}

const IDENT = /^(author|committer) (.*) <([^<>\n]*)> (\d+ [+-]\d{4})$/;

/**
 * Rewrites the commits in base..ref whose messages carry a closing keyword, keeping trees, authors, committers
 * and dates (signatures are dropped on rewritten commits), and moves `ref` to the new head. Returns how many
 * messages changed.
 */
export async function rewriteClosingKeywords(bareDir: string, baseSha: string, ref: string): Promise<number> {
  const lines = (await git(bareDir, ["rev-list", "--reverse", "--topo-order", "--parents", `${baseSha}..${ref}`])).split("\n").filter(Boolean);
  const mapped = new Map<string, string>();
  let changed = 0;
  let tmp: string | undefined;
  try {
    for (const line of lines) {
      const [sha, ...parents] = line.split(" ") as [string, ...string[]];
      const raw = await git(bareDir, ["cat-file", "commit", sha]);
      const split = raw.indexOf("\n\n");
      const headers = (split === -1 ? raw : raw.slice(0, split)).split("\n");
      const message = split === -1 ? "" : raw.slice(split + 2);
      const fixed = neutralizeClosingKeywords(message);
      const newParents = parents.map((p) => mapped.get(p) ?? p);
      if (fixed === message && newParents.every((p, i) => p === parents[i])) continue;
      if (fixed !== message) changed++;

      const env: Record<string, string> = {};
      let tree: string | undefined;
      for (const h of headers) {
        if (h.startsWith("tree ")) tree = h.slice(5);
        const m = IDENT.exec(h);
        if (!m) continue;
        const who = m[1] === "author" ? "AUTHOR" : "COMMITTER";
        env[`GIT_${who}_NAME`] = m[2]!;
        env[`GIT_${who}_EMAIL`] = m[3]!;
        env[`GIT_${who}_DATE`] = m[4]!;
      }
      if (!tree || !env.GIT_AUTHOR_NAME || !env.GIT_COMMITTER_NAME) throw new Error(`cannot rewrite commit ${sha.slice(0, 12)}: unexpected header`);
      tmp ??= await mkdtemp(join(tmpdir(), "globalhost-msg-"));
      const msgFile = join(tmp, "msg");
      await writeFile(msgFile, fixed);
      const out = await git(bareDir, ["commit-tree", tree, ...newParents.flatMap((p) => ["-p", p]), "-F", msgFile], env);
      mapped.set(sha, out.trim());
    }
    const head = lines.length > 0 ? lines[lines.length - 1]!.split(" ")[0]! : undefined;
    const newHead = head ? mapped.get(head) : undefined;
    if (newHead) await git(bareDir, ["update-ref", ref, newHead]);
    return changed;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
