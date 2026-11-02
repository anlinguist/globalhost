/**
 * Startup configuration from the environment. Anything missing or malformed throws
 * ConfigError, and main.ts exits non-zero: a guard that can't say what it checks must
 * not start (Cloud Run then never routes to the revision).
 */

export interface GuardConfig {
  /** Port the guard listens on (Cloud Run's ingress port). */
  port: number;
  /** Port of the app container on 127.0.0.1. */
  upstreamPort: number;
  /** Cloudflare Zero Trust team domain, e.g. `broken-haze-4579.cloudflareaccess.com`. */
  teamDomain: string;
  /** Expected `iss`: `https://<teamDomain>`. */
  issuer: string;
  /** Accepted `aud` values (Access application AUD tags); any one match passes. */
  audiences: string[];
  /** Where the signing keys are published. */
  jwksUrl: string;
  /** Path the guard answers itself with 200, for Cloud Run probes. */
  healthPath: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

// Access team domains are always `<team>.cloudflareaccess.com`. Being strict here
// catches a pasted URL (`https://...`) or a trailing slash, which would otherwise
// make every token fail the `iss` check at runtime instead of at startup.
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
// An Access application AUD tag is a 64-character hex string.
const AUD_TAG = /^[0-9a-f]{64}$/;
// Health path: absolute, plain characters, no dot segments, no query/fragment.
const HEALTH_PATH = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;

function port(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${name} is required`);
  }
  if (!/^[0-9]{1,5}$/.test(raw)) throw new ConfigError(`${name} must be a port number, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < 1 || n > 65535) throw new ConfigError(`${name} must be between 1 and 65535, got ${n}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): GuardConfig {
  const listen = port(env, "PORT", 8080);
  const upstreamPort = port(env, "UPSTREAM_PORT");
  if (listen === upstreamPort) throw new ConfigError("PORT and UPSTREAM_PORT must differ");

  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  if (teamDomain === "") throw new ConfigError("ACCESS_TEAM_DOMAIN is required (e.g. my-team.cloudflareaccess.com)");
  if (!TEAM_DOMAIN.test(teamDomain)) {
    throw new ConfigError(
      `ACCESS_TEAM_DOMAIN must be a bare host like my-team.cloudflareaccess.com (no scheme or path), got ${JSON.stringify(teamDomain)}`,
    );
  }

  const audRaw = env.ACCESS_AUD ?? "";
  const audiences = audRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (audiences.length === 0) throw new ConfigError("ACCESS_AUD is required (one or more comma-separated AUD tags)");
  for (const aud of audiences) {
    if (!AUD_TAG.test(aud)) throw new ConfigError(`ACCESS_AUD entries must be 64-character lowercase hex AUD tags, got ${JSON.stringify(aud)}`);
  }

  const healthPath = env.HEALTH_PATH === undefined || env.HEALTH_PATH === "" ? "/__guard/healthz" : env.HEALTH_PATH;
  if (!HEALTH_PATH.test(healthPath) || healthPath.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new ConfigError(`HEALTH_PATH must be an absolute path without dot segments, query or encoding, got ${JSON.stringify(healthPath)}`);
  }

  return {
    port: listen,
    upstreamPort,
    teamDomain,
    issuer: `https://${teamDomain}`,
    audiences: [...new Set(audiences)],
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    healthPath,
  };
}
