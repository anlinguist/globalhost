// GitHub REST for the dispatcher. Reads use the workflow's read-only GITHUB_TOKEN; writes use a
// globalhost-ai installation token minted for one repo just before publishing (ARCHITECTURE §5.1).
import { createSign } from "node:crypto";
import { z } from "zod";

const API = "https://api.github.com";

export class GitHubClient {
  constructor(
    /** Undefined for anonymous reads of public repos (local runs without GITHUB_TOKEN). */
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    const resp = await this.fetchImpl(`${API}${path}`, {
      method,
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "globalhost-dispatch",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) throw new GitHubError(method, path, resp.status);
    if (resp.status === 204) return undefined as T;
    const json: unknown = await resp.json();
    return schema ? schema.parse(json) : (json as T);
  }

  /**
   * GETs an API path whose answer is a redirect to a download (job logs, artifact zips). The redirect is
   * followed by hand so the token is never sent to the download host, and the body is read with a byte cap.
   */
  async download(path: string, opts: { maxBytes: number; keep?: "head" | "tail"; timeoutMs?: number }): Promise<Download> {
    const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const resp = await this.fetchImpl(`${API}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "globalhost-dispatch",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    let body = resp;
    let signal: AbortSignal | undefined;
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel().catch(() => undefined);
      let url: URL;
      try {
        url = new URL(resp.headers.get("location") ?? "");
      } catch {
        throw new GitHubError("GET", path, resp.status);
      }
      if (url.protocol !== "https:") throw new GitHubError("GET", path, resp.status);
      signal = AbortSignal.timeout(timeoutMs);
      body = await this.fetchImpl(url, { redirect: "error", headers: { "user-agent": "globalhost-dispatch" }, signal });
    }
    if (!body.ok) throw new GitHubError("GET", path, body.status);
    // The body gets its own bound too (a fresh one when there was no redirect), so a stalled stream can't hang the job.
    return readCapped(body, opts.maxBytes, opts.keep ?? "head", signal ?? AbortSignal.timeout(timeoutMs));
  }
}

export interface Download {
  data: Buffer;
  /** Bytes read from the body (all of it, unless reading stopped at a cap). */
  totalBytes: number;
  /** True when `data` is not the whole body. */
  truncated: boolean;
}

/** Each request of a download, and reading its body, must finish within this. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Reading stops after this many bytes even when keeping the tail, so one huge log can't stall the job. */
export const DOWNLOAD_HARD_CAP = 64 * 1024 * 1024;

/**
 * Reads a response body keeping at most `maxBytes`: the first bytes (`head`, then stops) or the last (`tail`,
 * reading on up to DOWNLOAD_HARD_CAP).
 */
export async function readCapped(resp: Response, maxBytes: number, keep: "head" | "tail", signal?: AbortSignal): Promise<Download> {
  if (!resp.body) return { data: Buffer.alloc(0), totalBytes: 0, truncated: false };
  const reader = resp.body.getReader();
  // Rejects when the signal fires, even if the stream itself ignores it.
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    const fail = () => reject(new Error("download timed out"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      chunks.push(chunk);
      kept += chunk.length;
      if (keep === "head" && kept > maxBytes) {
        truncated = true;
        break;
      }
      if (keep === "tail") {
        while (chunks.length > 1 && kept - chunks[0]!.length >= maxBytes) kept -= chunks.shift()!.length;
        if (total > DOWNLOAD_HARD_CAP) {
          truncated = true;
          break;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = Buffer.concat(chunks);
  if (all.length > maxBytes || total > all.length) truncated = true;
  const data = keep === "head" ? all.subarray(0, maxBytes) : all.subarray(Math.max(0, all.length - maxBytes));
  return { data: Buffer.from(data), totalBytes: total, truncated };
}

export class GitHubError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`GitHub ${method} ${path}: HTTP ${status}`);
  }
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** A 9-minute App JWT (GitHub allows at most 10), backdated 60 s for clock skew. */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** What the publisher needs, and nothing more: no workflows, no administration. */
export const PUBLISH_PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read" } as const;

/**
 * What the review poster needs (P2-01, shadow mode): post and update its review, add the escalation label and
 * remove `factory:review`. No contents write, so this token can't push or merge.
 */
export const REVIEW_PERMISSIONS = { issues: "write", pull_requests: "write", metadata: "read" } as const;

/** An installation token scoped to REVIEW_PERMISSIONS: the only write token the review step uses. */
export function reviewInstallationToken(appId: string, privateKeyPem: string, repo: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  return installationToken(appId, privateKeyPem, repo, fetchImpl, REVIEW_PERMISSIONS);
}

export async function installationToken(
  appId: string,
  privateKeyPem: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
  permissions: Readonly<Record<string, "read" | "write">> = PUBLISH_PERMISSIONS,
): Promise<string> {
  const app = new GitHubClient(appJwt(appId, privateKeyPem), fetchImpl);
  const installation = await app.request("GET", `/repos/${repo}/installation`, undefined, z.object({ id: z.number().int() }));
  const minted = await app.request(
    "POST",
    `/app/installations/${installation.id}/access_tokens`,
    { repositories: [repo.split("/")[1]], permissions },
    z.object({ token: z.string() }),
  );
  return minted.token;
}

export const CommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable(),
  user: z.object({ login: z.string(), id: z.number().int(), type: z.string() }),
});
export type Comment = z.infer<typeof CommentSchema>;

export const PullSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string() }),
  html_url: z.string(),
});
export type Pull = z.infer<typeof PullSchema>;

/** Lists an issue's (or PR's) comments, newest last, up to 300. */
export async function listComments(gh: GitHubClient, repo: string, issue: number): Promise<Comment[]> {
  const all: Comment[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh.request("GET", `/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`, undefined, z.array(CommentSchema));
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// Hidden markers on the bot's own comments carry run metadata between workflow runs (no hidden state:
// it's all on GitHub). Only comments by the App's bot user are trusted to carry them.
const MARKER = /<!-- globalhost:run (\{[^\n]{1,500}\}) -->/;
export const MarkerSchema = z.object({
  role: z.enum(["planner", "builder"]),
  session: z.string().regex(/^sesn_[A-Za-z0-9]+$/),
  run: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  /** Cumulative session cost when this comment was written, for spend deltas on resume. */
  costUsd: z.number().nonnegative(),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const marker = (m: Marker) => `<!-- globalhost:run ${JSON.stringify(m)} -->`;

export function latestMarker(comments: readonly Comment[], botLogin: string, role?: Marker["role"]): { marker: Marker; comment: Comment } | undefined {
  for (const c of [...comments].reverse()) {
    if (c.user.type !== "Bot" || c.user.login !== botLogin || !c.body) continue;
    const m = MARKER.exec(c.body);
    if (!m) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const parsed = MarkerSchema.safeParse(raw);
    if (parsed.success && (!role || parsed.data.role === role)) return { marker: parsed.data, comment: c };
  }
  return undefined;
}
