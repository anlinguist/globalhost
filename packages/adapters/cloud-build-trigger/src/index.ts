// `cloud-build-trigger` deploy adapter (docs/PROFILES.md §3): observe-only. The product's existing Cloud Build
// trigger deploys on push to the default branch; this adapter finds the build for a merge commit and reports its
// status. It never starts, retries or cancels a build, so adopting it changes nothing about how the product deploys.
import {
  GCP_PROJECT_PATTERN,
  REGION_PATTERN,
  z,
  type DeployAdapter,
  type ReleaseCtx,
  type ReleaseHandle,
  type ReleaseState,
  type ReleaseStatus,
} from "@globalhost/core";

export const ADAPTER_ID = "cloud-build-trigger";
export const CLOUD_BUILD_API = "https://cloudbuild.googleapis.com/v1";

const TRIGGER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PAGE_SIZE = 50;
/** Builds searched per lookup (newest first); a merge older than this is reported as not found. */
export const MAX_BUILDS_SEARCHED = 200;

const region = z.string().refine((r) => r === "global" || REGION_PATTERN.test(r), { error: 'must be "global" or a GCP region such as us-central1' });

export const cloudBuildTriggerConfigSchema = z.strictObject({
  /** GCP project that owns the trigger. */
  project: z.string().regex(GCP_PROJECT_PATTERN, { error: "must be a GCP project id" }),
  /** The trigger's name or id. */
  trigger: z.string().regex(TRIGGER_PATTERN, { error: "must be a Cloud Build trigger name or id: letters, digits, - and _, at most 64 characters" }),
  /** Trigger location; "global" for triggers created without a region. */
  region: region.default("global"),
});
export type CloudBuildTriggerConfig = z.output<typeof cloudBuildTriggerConfigSchema>;

/** The parts of a Cloud Build `Build` resource this adapter reads. Unknown fields are ignored. */
const buildSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  status: z.string().optional(),
  statusDetail: z.string().optional(),
  buildTriggerId: z.string().optional(),
  substitutions: z.record(z.string(), z.string()).optional(),
  sourceProvenance: z
    .object({
      resolvedRepoSource: z.object({ commitSha: z.string().optional() }).optional(),
      resolvedGitSource: z.object({ revision: z.string().optional() }).optional(),
    })
    .optional(),
  createTime: z.string().optional(),
  logUrl: z.string().optional(),
});
export type CloudBuild = z.output<typeof buildSchema>;

const listBuildsSchema = z.object({ builds: z.array(buildSchema).optional(), nextPageToken: z.string().optional() });
const triggerSchema = z.object({ id: z.string().regex(ID_PATTERN), name: z.string().optional() });
const errorSchema = z.object({ error: z.object({ code: z.number().optional(), status: z.string().optional() }) });

/** What `release()` records and `status()` reads back. All values are identifiers; no credentials. */
const handleDataSchema = z.strictObject({
  project: z.string().regex(GCP_PROJECT_PATTERN),
  region,
  triggerId: z.string().regex(ID_PATTERN),
  buildId: z.string().regex(ID_PATTERN).optional(),
});
type HandleData = z.output<typeof handleDataSchema>;

/** Cloud Build `Build.Status` → release state. Anything unlisted (incl. STATUS_UNKNOWN) is "unknown". */
export const STATUS_MAP: Readonly<Record<string, ReleaseState>> = {
  PENDING: "pending",
  QUEUED: "pending",
  WORKING: "running",
  SUCCESS: "succeeded",
  FAILURE: "failed",
  INTERNAL_ERROR: "failed",
  TIMEOUT: "failed",
  EXPIRED: "failed",
  CANCELLED: "cancelled",
};

export class CloudBuildApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly apiStatus: string | undefined,
    what: string,
  ) {
    super(`Cloud Build API ${what}: HTTP ${httpStatus}${apiStatus ? ` ${apiStatus}` : ""}`);
    this.name = "CloudBuildApiError";
  }
}

export interface CloudBuildTriggerDeps {
  /** Returns an OAuth access token for a principal with cloudbuild.builds.list/get on the project. */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch;
  /** Override for tests. */
  baseUrl?: string;
}

/** The commit a build ran on, from the trigger's substitutions or the resolved source. */
export function buildCommit(build: CloudBuild): string | undefined {
  return (
    build.substitutions?.COMMIT_SHA ??
    build.sourceProvenance?.resolvedRepoSource?.commitSha ??
    build.sourceProvenance?.resolvedGitSource?.revision ??
    build.substitutions?.REVISION_ID
  );
}

export function buildStatus(build: CloudBuild): ReleaseStatus {
  const raw = build.status ?? "STATUS_UNKNOWN";
  const state = STATUS_MAP[raw] ?? "unknown";
  const detail = `Cloud Build ${build.id}: ${raw}${build.statusDetail ? ` (${build.statusDetail.slice(0, 200)})` : ""}`;
  const url = build.logUrl?.startsWith("https://console.cloud.google.com/") ? build.logUrl : undefined;
  return url ? { state, detail, url } : { state, detail };
}

export function createCloudBuildTriggerAdapter(deps: CloudBuildTriggerDeps): DeployAdapter<CloudBuildTriggerConfig> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const base = deps.baseUrl ?? CLOUD_BUILD_API;

  async function get<T>(path: string, schema: z.ZodType<T>, what: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const token = await deps.accessToken();
    const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const parsed = errorSchema.safeParse(body);
      throw new CloudBuildApiError(res.status, parsed.success ? parsed.data.error.status : undefined, what);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error(`Cloud Build API ${what}: unexpected response shape`);
    return parsed.data;
  }

  const location = (d: { project: string; region: string }) =>
    `projects/${encodeURIComponent(d.project)}/locations/${encodeURIComponent(d.region)}`;

  async function findBuild(data: HandleData, sha: string): Promise<CloudBuild | undefined> {
    let pageToken: string | undefined;
    for (let seen = 0; seen < MAX_BUILDS_SEARCHED; seen += PAGE_SIZE) {
      const query: Record<string, string> = { filter: `trigger_id="${data.triggerId}"`, pageSize: String(PAGE_SIZE) };
      if (pageToken) query.pageToken = pageToken;
      const page = await get(`${location(data)}/builds`, listBuildsSchema, "list builds", query);
      // Newest first (the API's order); a re-run for the same commit supersedes the earlier build.
      const match = (page.builds ?? [])
        .filter((b) => buildCommit(b) === sha && (b.buildTriggerId === undefined || b.buildTriggerId === data.triggerId))
        .sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""))[0];
      if (match) return match;
      pageToken = page.nextPageToken;
      if (!pageToken) return undefined;
    }
    return undefined;
  }

  const notFound = (sha: string): ReleaseStatus => ({ state: "pending", detail: `no Cloud Build build for ${sha} yet` });

  return {
    id: ADAPTER_ID,
    configSchema: cloudBuildTriggerConfigSchema,
    capabilities: { preview: false, canary: false, rollback: false, asyncGate: false },

    async release(ctx: ReleaseCtx, cfg: CloudBuildTriggerConfig): Promise<ReleaseHandle> {
      if (!SHA_PATTERN.test(ctx.sha)) throw new Error("release sha must be 40 lowercase hex characters");
      const config = cloudBuildTriggerConfigSchema.parse(cfg);
      const trigger = await get(
        `${location(config)}/triggers/${encodeURIComponent(config.trigger)}`,
        triggerSchema,
        "get trigger",
      );
      const data: HandleData = { project: config.project, region: config.region, triggerId: trigger.id };
      const build = await findBuild(data, ctx.sha);
      if (build) data.buildId = build.id;
      return { adapter: ADAPTER_ID, sha: ctx.sha, data };
    },

    async status(handle: ReleaseHandle): Promise<ReleaseStatus> {
      if (handle.adapter !== ADAPTER_ID) throw new Error(`handle belongs to adapter ${JSON.stringify(handle.adapter)}`);
      if (!SHA_PATTERN.test(handle.sha)) throw new Error("handle sha must be 40 lowercase hex characters");
      const data = handleDataSchema.parse(handle.data);
      if (data.buildId) {
        const build = await get(`${location(data)}/builds/${encodeURIComponent(data.buildId)}`, buildSchema, "get build");
        return buildStatus(build);
      }
      const build = await findBuild(data, handle.sha);
      return build ? buildStatus(build) : notFound(handle.sha);
    },
  };
}

/**
 * The adapter as registered with the CLI, for validation only. Calling `release`/`status` on it fails: the
 * runner and watcher build their own with `createCloudBuildTriggerAdapter({ accessToken })`.
 */
export const cloudBuildTrigger: DeployAdapter<CloudBuildTriggerConfig> = createCloudBuildTriggerAdapter({
  accessToken: () => Promise.reject(new Error("cloud-build-trigger: no access-token provider configured")),
});
