// Read-only GitHub inputs for a run: the repo, the issue and its comments. The token, if any, is a
// read-only one (ARCHITECTURE §5.1); it's used here in trusted code and never reaches the session.
import { z } from "zod";

const UserSchema = z.object({ login: z.string(), id: z.number().int() });

const RepoSchema = z.object({
  full_name: z.string(),
  clone_url: z.string().url(),
  default_branch: z.string(),
  private: z.boolean(),
  owner: UserSchema,
});

const IssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  user: UserSchema,
  state: z.string(),
  pull_request: z.unknown().optional(),
});

const CommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable(),
  user: UserSchema,
  created_at: z.string(),
});

export type RepoInfo = z.infer<typeof RepoSchema>;
export interface Author {
  login: string;
  id: number;
}
export interface IssueText {
  author: Author;
  body: string;
}
export interface IssueInput {
  number: number;
  title: string;
  author: Author;
  body: string;
  comments: (IssueText & { id: number; createdAt: string })[];
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_COMMENTS = 100;

export function parseRepo(slug: string): string {
  if (!REPO_RE.test(slug) || slug.includes("..")) throw new Error(`not an owner/name repo slug: ${slug}`);
  return slug;
}

export class GitHubReader {
  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  private async get(path: string): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "globalhost-runner",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const resp = await this.fetchImpl(`${this.apiBase}${path}`, { headers, redirect: "error" });
    if (!resp.ok) throw new Error(`GitHub GET ${path}: HTTP ${resp.status}`);
    return resp.json();
  }

  async repo(slug: string): Promise<RepoInfo> {
    return RepoSchema.parse(await this.get(`/repos/${parseRepo(slug)}`));
  }

  async issue(slug: string, number: number): Promise<IssueInput> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`bad issue number: ${number}`);
    const base = `/repos/${parseRepo(slug)}/issues/${number}`;
    const issue = IssueSchema.parse(await this.get(base));
    const comments = z.array(CommentSchema).parse(await this.get(`${base}/comments?per_page=${MAX_COMMENTS}`));
    return {
      number: issue.number,
      title: issue.title,
      author: { login: issue.user.login, id: issue.user.id },
      body: issue.body ?? "",
      comments: comments.map((c) => ({
        id: c.id,
        author: { login: c.user.login, id: c.user.id },
        body: c.body ?? "",
        createdAt: c.created_at,
      })),
    };
  }
}
