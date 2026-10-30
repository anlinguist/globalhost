// Repository facts over the GitHub REST API, read-only: visibility, default branch, workflows, people.
// Anonymous reads work for public repos; collaborators need a token with push access and report "unavailable" without one.
import { GitHubError, type GitHubClient } from "@globalhost/dispatch";
import { z } from "zod";
import { listed, unavailable, type Listing } from "../common.js";

const PersonSchema = z.object({ login: z.string(), id: z.number().int(), type: z.string() });

export const RepoResponseSchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  visibility: z.enum(["public", "private", "internal"]).optional(),
  default_branch: z.string(),
  archived: z.boolean(),
  fork: z.boolean(),
  pushed_at: z.string().nullable(),
  clone_url: z.string(),
  owner: PersonSchema,
});

const WorkflowsSchema = z.object({
  total_count: z.number().int(),
  workflows: z.array(z.object({ name: z.string(), path: z.string(), state: z.string() })),
});
const ContributorsSchema = z.array(PersonSchema.extend({ contributions: z.number().int() }));
const CollaboratorsSchema = z.array(PersonSchema.extend({ role_name: z.string().optional() }));

export type Person = z.infer<typeof PersonSchema>;
export interface Workflow {
  name: string;
  path: string;
  state: string;
}

export interface RepoFacts {
  repo: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
  cloneUrl: string;
  owner: Person;
  workflows: Listing<Workflow>;
  contributors: Listing<Person & { contributions: number }>;
  collaborators: Listing<Person & { role: string }>;
  /** Contributors who are neither the owner nor a collaborator; only known when collaborators are. */
  outsideContributors: Listing<Person & { contributions: number }>;
}

const PAGE = 100;

async function optional<T>(what: string, fetch: () => Promise<T>): Promise<T | { failed: string }> {
  try {
    return await fetch();
  } catch (err) {
    if (err instanceof GitHubError) {
      return { failed: err.status === 401 || err.status === 403 ? "needs a token with push access" : `HTTP ${err.status}` };
    }
    if (err instanceof z.ZodError) return { failed: `unexpected ${what} response shape` };
    throw err;
  }
}

const failed = (v: unknown): v is { failed: string } => typeof v === "object" && v !== null && "failed" in v;

export async function githubRepoFacts(gh: GitHubClient, repo: string): Promise<RepoFacts> {
  const r = await gh.request("GET", `/repos/${repo}`, undefined, RepoResponseSchema);
  const workflows = await optional("workflows", () => gh.request("GET", `/repos/${repo}/actions/workflows?per_page=${PAGE}`, undefined, WorkflowsSchema));
  const contributors = await optional("contributors", () => gh.request("GET", `/repos/${repo}/contributors?per_page=${PAGE}`, undefined, ContributorsSchema));
  const collaborators = await optional("collaborators", () =>
    gh.request("GET", `/repos/${repo}/collaborators?per_page=${PAGE}&affiliation=all`, undefined, CollaboratorsSchema),
  );

  let outside: RepoFacts["outsideContributors"];
  if (failed(contributors)) outside = unavailable(contributors.failed);
  else if (failed(collaborators)) outside = unavailable("needs the collaborator list");
  else {
    const known = new Set([r.owner.id, ...collaborators.map((c) => c.id)]);
    outside = listed(
      contributors.filter((c) => !known.has(c.id) && c.type !== "Bot").map((c) => ({ login: c.login, id: c.id, type: c.type, contributions: c.contributions })),
      PAGE,
    );
  }

  return {
    repo: r.full_name,
    visibility: r.visibility ?? (r.private ? "private" : "public"),
    defaultBranch: r.default_branch,
    archived: r.archived,
    fork: r.fork,
    pushedAt: r.pushed_at,
    cloneUrl: r.clone_url,
    owner: { login: r.owner.login, id: r.owner.id, type: r.owner.type },
    workflows: failed(workflows)
      ? unavailable(workflows.failed)
      : { ok: true, items: workflows.workflows.map((w) => ({ name: w.name, path: w.path, state: w.state })), truncated: workflows.total_count > workflows.workflows.length },
    contributors: failed(contributors)
      ? unavailable(contributors.failed)
      : { ok: true, items: contributors.map((c) => ({ login: c.login, id: c.id, type: c.type, contributions: c.contributions })), truncated: contributors.length >= PAGE },
    collaborators: failed(collaborators)
      ? unavailable(collaborators.failed)
      : { ok: true, items: collaborators.map((c) => ({ login: c.login, id: c.id, type: c.type, role: c.role_name ?? "unknown" })), truncated: collaborators.length >= PAGE },
    outsideContributors: outside,
  };
}
