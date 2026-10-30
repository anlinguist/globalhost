// Keyless Anthropic auth (ADR-0014): an OIDC identity token is exchanged through a Console federation
// rule for a ~10-minute token. There is no API key anywhere in the factory.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";

const run = promisify(execFile);

export const ANTHROPIC_AUDIENCE = "https://api.anthropic.com";
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** Non-secret identifiers of one federation rule (ADR-0014). */
export interface FederationIds {
  organizationId: string;
  federationRuleId: string;
  serviceAccountId: string;
  workspaceId: string;
}

export type IdentityTokenSource = () => Promise<string>;

const ENV_NAMES: Record<keyof FederationIds, string> = {
  organizationId: "ANTHROPIC_ORGANIZATION_ID",
  federationRuleId: "ANTHROPIC_FEDERATION_RULE_ID",
  serviceAccountId: "ANTHROPIC_SERVICE_ACCOUNT_ID",
  workspaceId: "ANTHROPIC_WORKSPACE_ID",
};

export function federationIdsFromEnv(env: NodeJS.ProcessEnv = process.env): FederationIds {
  const missing = Object.values(ENV_NAMES).filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  return Object.fromEntries(
    Object.entries(ENV_NAMES).map(([key, name]) => [key, env[name] as string]),
  ) as unknown as FederationIds;
}

/**
 * Local runs (`globalhost run`): the owner's gcloud login mints an identity token for a
 * permissionless service account. generateIdToken needs only roles/iam.serviceAccountOpenIdTokenCreator
 * on that one account; gcloud's --impersonate-service-account would need TokenCreator.
 */
export function googleImpersonatedIdentity(serviceAccountEmail: string, fetchImpl: typeof fetch = fetch): IdentityTokenSource {
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)) {
    throw new Error(`not a service account email: ${serviceAccountEmail}`);
  }
  return async () => {
    const { stdout } = await run("gcloud", ["auth", "print-access-token"]);
    const resp = await fetchImpl(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateIdToken`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${stdout.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ audience: ANTHROPIC_AUDIENCE, includeEmail: true }),
      },
    );
    if (!resp.ok) throw new Error(`generateIdToken for ${serviceAccountEmail} failed: HTTP ${resp.status}`);
    const body = (await resp.json()) as { token?: unknown };
    if (typeof body.token !== "string") throw new Error("generateIdToken returned no token");
    return body.token;
  };
}

/** Dispatcher runs: the GitHub Actions OIDC token of the job (needs `permissions: id-token: write`). */
export function githubActionsIdentity(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): IdentityTokenSource {
  return async () => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) throw new Error("no GitHub Actions OIDC token available (is id-token: write set?)");
    const target = new URL(url);
    target.searchParams.set("audience", ANTHROPIC_AUDIENCE);
    const resp = await fetchImpl(target, { headers: { authorization: `Bearer ${bearer}` } });
    if (!resp.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${resp.status}`);
    const body = (await resp.json()) as { value?: unknown };
    if (typeof body.value !== "string") throw new Error("GitHub OIDC response had no token");
    return body.value;
  };
}

export function anthropicClient(ids: FederationIds, identity: IdentityTokenSource): Anthropic {
  return new Anthropic({
    credentials: oidcFederationProvider({
      identityTokenProvider: identity,
      ...ids,
      baseURL: "https://api.anthropic.com",
      fetch,
    }),
  });
}
