// `cloud-build-trigger` deploy adapter (docs/PROFILES.md §3): observe-only. The product's existing Cloud Build
// trigger deploys on push to the default branch; this adapter finds the build for a merge commit and reports its
// status. It never starts, retries or cancels a build, so adopting it changes nothing about how the product deploys.
// A successful build isn't a deploy (ADR-0019): `verifyLive()` checks the configured Cloud Run service serves it.
import {
  GCP_PROJECT_PATTERN,
  GLOB_PATTERN,
  REGION_PATTERN,
  z,
  type DeployAdapter,
  type ReleaseCtx,
  type ReleaseExecutionSet,
  type ReleaseHandle,
  type ReleaseLiveness,
  type ReleaseState,
  type ReleaseStatus,
} from "@globalhost/core";
import { CLOUD_RUN_SERVICE_PATTERN, cloudRunRevisionSchema, cloudRunServiceSchema, liveness } from "./live.js";

export * from "./live.js";

export const ADAPTER_ID = "cloud-build-trigger";
export const CLOUD_BUILD_API = "https://cloudbuild.googleapis.com/v1";
export const CLOUD_RUN_API = "https://run.googleapis.com/v2";
/** Per-request timeout for Cloud Build and Cloud Run calls. */
export const REQUEST_TIMEOUT_MS = 30_000;

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
  /**
   * The Cloud Run service the trigger deploys, in `environments.prod.gcpProject`. A successful build is reported as
   * deployed only once this service serves the merged commit; without it the build is reported but never as deployed.
   */
  cloudRun: z
    .strictObject({
      service: z.string().regex(CLOUD_RUN_SERVICE_PATTERN, {
        error: "must be a Cloud Run service name: lowercase letters, digits and hyphens, starting with a letter, at most 49 characters",
      }),
      region: z.string().regex(REGION_PATTERN, { error: "must be a GCP region such as us-central1" }),
    })
    .optional(),
  /** The trigger's build config file, repo-relative. Only needed when it isn't `cloudbuild.yaml`. */
  buildConfig: z
    .string()
    .regex(GLOB_PATTERN, { error: "must be a repo-relative path" })
    .refine((p) => !/[*?]/.test(p), { error: "must be a path, not a glob" })
    .optional(),
  /** Repo-relative globs of anything else the build config's steps run, such as a deploy script. */
  releaseInputs: z.array(z.string().regex(GLOB_PATTERN, { error: "must be a glob" })).max(100).optional(),
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
  /** Images listed under the build config's `images:`, pushed by Cloud Build once every step succeeded. */
  results: z.object({ images: z.array(z.object({ name: z.string().optional(), digest: z.string().optional() })).optional() }).optional(),
});
export type CloudBuild = z.output<typeof buildSchema>;

const listBuildsSchema = z.object({ builds: z.array(buildSchema).optional(), nextPageToken: z.string().optional() });
const triggerSchema = z.object({ id: z.string().regex(ID_PATTERN), name: z.string().optional() });
const errorSchema = z.object({ error: z.object({ code: z.number().optional(), status: z.string().optional() }) });

/** What `release()` records and `status()` reads back. All values are identifiers; no credentials. */
const handleDataSchema = z
  .strictObject({
    project: z.string().regex(GCP_PROJECT_PATTERN),
    region,
    triggerId: z.string().regex(ID_PATTERN),
    buildId: z.string().regex(ID_PATTERN).optional(),
    /** The Cloud Run service to verify: all three or none. */
    runProject: z.string().regex(GCP_PROJECT_PATTERN).optional(),
    runRegion: z.string().regex(REGION_PATTERN).optional(),
    runService: z.string().regex(CLOUD_RUN_SERVICE_PATTERN).optional(),
  })
  .refine((d) => new Set([d.runProject, d.runRegion, d.runService].map((v) => v === undefined)).size === 1, {
    error: "runProject, runRegion and runService go together",
  });
type HandleData = z.output<typeof handleDataSchema>;

const DEFAULT_BUILD_CONFIG = "cloudbuild.yaml";

/**
 * What a Cloud Build trigger runs with its service account: the build config, and the image definition and upload
 * filter its docker step reads. At any depth, since a config can point a build anywhere in the repo. The build's whole
 * context isn't in the set (`COPY . .` would make it every file); application code is what the build/deploy split of
 * ADR-0015 §9 is for. Steps that run a repo script need it listed in `releaseInputs`.
 */
export const BUILD_DEFINITION_GLOBS: readonly string[] = Object.freeze([
  "**/cloudbuild.yaml",
  "**/cloudbuild.yml",
  "**/cloudbuild.json",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.Dockerfile",
  "**/.dockerignore",
  "**/.gcloudignore",
]);

export function cloudBuildReleaseSet(cfg: CloudBuildTriggerConfig): ReleaseExecutionSet {
  const config = cloudBuildTriggerConfigSchema.parse(cfg);
  return { globs: [...new Set([config.buildConfig ?? DEFAULT_BUILD_CONFIG, ...BUILD_DEFINITION_GLOBS, ...(config.releaseInputs ?? [])])] };
}

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

/** A Cloud Run API error (HTTP status and API status only, never the body). */
export class CloudRunApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly apiStatus: string | undefined,
    what: string,
  ) {
    super(`Cloud Run API ${what}: HTTP ${httpStatus}${apiStatus ? ` ${apiStatus}` : ""}`);
    this.name = "CloudRunApiError";
  }
}

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
  /**
   * Returns an OAuth access token for a principal with cloudbuild.builds.list/get on the project and, for
   * `verifyLive()`, run.services.get and run.revisions.get on the prod project.
   */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch;
  /** Overrides for tests. */
  baseUrl?: string;
  runBaseUrl?: string;
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
  const runBase = deps.runBaseUrl ?? CLOUD_RUN_API;

  async function request<T>(api: "build" | "run", path: string, schema: z.ZodType<T>, what: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${api === "build" ? base : runBase}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const token = await deps.accessToken();
    // A hung connection must not eat the job's timeout; the abort is retried like a network error.
    const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body: unknown = await res.json().catch((e: unknown) => {
      // A timeout while reading the body is retryable like any other; only an unparseable body is swallowed.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
      return undefined;
    });
    if (!res.ok) {
      const parsed = errorSchema.safeParse(body);
      const apiStatus = parsed.success ? parsed.data.error.status : undefined;
      throw api === "build" ? new CloudBuildApiError(res.status, apiStatus, what) : new CloudRunApiError(res.status, apiStatus, what);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error(`Cloud ${api === "build" ? "Build" : "Run"} API ${what}: unexpected response shape`);
    return parsed.data;
  }
  const get = <T>(path: string, schema: z.ZodType<T>, what: string, query?: Record<string, string>) => request("build", path, schema, what, query);

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

    releaseExecutionSet: (_part, cfg) => cloudBuildReleaseSet(cfg),

    async release(ctx: ReleaseCtx, cfg: CloudBuildTriggerConfig): Promise<ReleaseHandle> {
      if (!SHA_PATTERN.test(ctx.sha)) throw new Error("release sha must be 40 lowercase hex characters");
      const config = cloudBuildTriggerConfigSchema.parse(cfg);
      const trigger = await get(
        `${location(config)}/triggers/${encodeURIComponent(config.trigger)}`,
        triggerSchema,
        "get trigger",
      );
      const data: HandleData = { project: config.project, region: config.region, triggerId: trigger.id };
      // The service is checked in the prod environment's project; without a valid one there's nothing to verify.
      if (config.cloudRun && GCP_PROJECT_PATTERN.test(ctx.environment.gcpProject)) {
        Object.assign(data, { runProject: ctx.environment.gcpProject, runRegion: config.cloudRun.region, runService: config.cloudRun.service });
      }
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

    async verifyLive(handle: ReleaseHandle): Promise<ReleaseLiveness> {
      if (handle.adapter !== ADAPTER_ID) throw new Error(`handle belongs to adapter ${JSON.stringify(handle.adapter)}`);
      if (!SHA_PATTERN.test(handle.sha)) throw new Error("handle sha must be 40 lowercase hex characters");
      const data = handleDataSchema.parse(handle.data);
      if (!data.runProject || !data.runRegion || !data.runService) return { state: "unverifiable", reason: "no-target" };
      // release() records the build id only when the build already existed; otherwise look it up as status() does.
      const build = data.buildId
        ? await get(`${location(data)}/builds/${encodeURIComponent(data.buildId)}`, buildSchema, "get build")
        : await findBuild(data, handle.sha);
      if (!build || build.status !== "SUCCESS" || buildCommit(build) !== handle.sha) throw new Error("verifyLive: not a successful build of this commit");
      const service = `projects/${encodeURIComponent(data.runProject)}/locations/${encodeURIComponent(data.runRegion)}/services/${encodeURIComponent(data.runService)}`;
      return liveness(
        handle.sha,
        build.results?.images,
        () => request("run", service, cloudRunServiceSchema, "get service"),
        (rev) => request("run", `${service}/revisions/${encodeURIComponent(rev)}`, cloudRunRevisionSchema, "get revision"),
      );
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
