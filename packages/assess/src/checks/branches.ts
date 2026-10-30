// Branches and flow, from a bare clone of every branch: each branch's tip, last commit date, and how far it
// is ahead of / behind the default branch. Branch names are repo-derived, so renderers treat them as untrusted.
import { git } from "@globalhost/runner";
import type { Listing } from "../common.js";

export interface BranchFact {
  name: string;
  sha: string;
  lastCommitAt: string;
  /** Commits on this branch not on the default branch. */
  ahead: number;
  /** Commits on the default branch not on this one. */
  behind: number;
}

export interface BranchFacts {
  defaultBranch: string;
  defaultSha: string;
  /** Every other branch, most recently committed first. */
  others: Listing<BranchFact>;
}

const MAX_BRANCHES = 30;

export async function branchFacts(bareDir: string, defaultBranch: string): Promise<BranchFacts> {
  const raw = await git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)", "refs/heads/"], {
    cwd: bareDir,
  });
  const refs = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", date = ""] = line.split("\0");
      return { name: ref.replace(/^refs\/heads\//, ""), sha, date };
    });
  const def = refs.find((r) => r.name === defaultBranch);
  if (!def) throw new Error(`the clone has no default branch ${defaultBranch}`);

  const others = refs.filter((r) => r.name !== defaultBranch);
  const items: BranchFact[] = [];
  for (const b of others.slice(0, MAX_BRANCHES)) {
    const counts = await git(["rev-list", "--left-right", "--count", `${def.sha}...${b.sha}`], { cwd: bareDir });
    const [behind = "0", ahead = "0"] = counts.trim().split(/\s+/);
    items.push({ name: b.name, sha: b.sha, lastCommitAt: b.date, ahead: Number(ahead), behind: Number(behind) });
  }
  return { defaultBranch, defaultSha: def.sha, others: { ok: true, items, truncated: others.length > MAX_BRANCHES } };
}
