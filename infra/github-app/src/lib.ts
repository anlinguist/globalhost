// Pure pieces of the GitHub App scripts (manifest, JWT, token permission sets, response schemas).
// The entry points (create-app.ts, token.ts) do the I/O.
import { sign } from "node:crypto";
import { z } from "zod";

export const APP_NAME = "globalhost-ai";
export const PROJECT = "globalhost-factory";
export const SECRET = "github-app-key";
export const GITHUB_API = "https://api.github.com";

/** ARCHITECTURE §5.1: exactly these, nothing else. */
export const APP_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  actions: "read",
  metadata: "read",
} as const;

/** Never requested. `workflows` above all: without it the App cannot change .github/workflows/**. */
export const FORBIDDEN_PERMISSIONS = [
  "workflows",
  "administration",
  "secrets",
  "members",
  "environments",
  "actions_variables",
  "organization_administration",
  "organization_secrets",
] as const;

export type Access = "read" | "write";
type TokenPermissions = Partial<Record<keyof typeof APP_PERMISSIONS, "read" | "write">>;

/** Installation-token permission subsets for P1-05's AC (metadata:read is always implied). */
export const TOKEN_PERMISSIONS: Record<Access, TokenPermissions> = {
  read: { contents: "read", issues: "read", pull_requests: "read" },
  write: { contents: "write", issues: "write", pull_requests: "write" },
};

export interface Manifest {
  name: string;
  url: string;
  description: string;
  public: boolean;
  redirect_url: string;
  hook_attributes: { url: string; active: boolean };
  default_permissions: Record<string, string>;
  default_events: string[];
  request_oauth_on_install: boolean;
  setup_on_update: boolean;
}

export function buildManifest(redirectUrl: string): Manifest {
  return {
    name: APP_NAME,
    url: "https://github.com/anlinguist/globalhost",
    description: "globalhost factory bot: pushes factory/* branches and opens PRs. No workflow or admin access.",
    public: false,
    redirect_url: redirectUrl,
    // GitHub requires a hook URL in the manifest; the webhook is created inactive and never used
    // (the factory is driven by Actions events in each repo, not by App webhooks).
    hook_attributes: { url: "https://globalhost.ai/unused-github-app-webhook", active: false },
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Local page that POSTs the manifest to GitHub (the manifest flow has to start from a form post). */
export function renderStartPage(manifest: Manifest, state: string): string {
  const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create ${escapeHtml(manifest.name)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>Create GitHub App <code>${escapeHtml(manifest.name)}</code></h1>
<p>Permissions: ${Object.entries(manifest.default_permissions)
    .map(([k, v]) => `<code>${escapeHtml(k)}: ${escapeHtml(v)}</code>`)
    .join(", ")}. Webhook inactive.</p>
<form action="${escapeHtml(action)}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue on github.com</button>
</form>
</body></html>`;
}

export const ConversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  html_url: z.string().url(),
  pem: z.string().regex(/^-----BEGIN (RSA )?PRIVATE KEY-----\n/),
});
export type Conversion = z.infer<typeof ConversionSchema>;

export const InstallationSchema = z.object({ id: z.number().int().positive() });
export const AccessTokenSchema = z.object({
  token: z.string().min(20),
  expires_at: z.string(),
  permissions: z.record(z.string(), z.string()),
});

/** The manifest-flow code is interpolated into a URL path; accept only what GitHub issues. */
export function isValidManifestCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(code);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** App JWT (RS256), valid ≤10 min as GitHub requires; iat backdated 60 s for clock skew. */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

export function parseRepo(full: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(full);
  if (!m?.[1] || !m[2]) throw new Error(`expected owner/repo, got ${JSON.stringify(full)}`);
  return { owner: m[1], repo: m[2] };
}

export function githubHeaders(auth?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "globalhost-infra",
    ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
  };
}
