// Is the merged commit what the Cloud Run service serves? (ADR-0019.) A Cloud Build SUCCESS only says the build's
// steps exited 0: a trigger whose build is `echo hello world`, or one that deploys a different service, succeeds too.
// So after the build succeeds we read the service (run.googleapis.com v2) and require that 100% of its traffic is on
// one ready revision running an image this build pushed: matched by digest when the revision pins one, otherwise by a
// tag equal to the commit's full or short SHA in a repository the build pushed to.
import { z, type ReleaseLiveness } from "@globalhost/core";

/** Cloud Run service names: lowercase letters, digits and hyphens, starting with a letter, at most 49 characters. */
export const CLOUD_RUN_SERVICE_PATTERN = /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/;
/** Revision names are `<service>-<generation>-<suffix>`; at most 63 characters. */
export const CLOUD_RUN_REVISION_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/** The parts of a v2 `Service` this reads. Unknown fields are ignored. */
const conditionSchema = z.object({ type: z.string().optional(), state: z.string().optional() });
export const cloudRunServiceSchema = z.object({
  reconciling: z.boolean().optional(),
  latestReadyRevision: z.string().optional(),
  trafficStatuses: z
    .array(
      z.object({
        type: z.string().optional(),
        revision: z.string().optional(),
        percent: z.number().int().min(0).max(100).optional(),
      }),
    )
    .optional(),
});
export type CloudRunService = z.output<typeof cloudRunServiceSchema>;

/** The parts of a v2 `Revision` this reads. */
export const cloudRunRevisionSchema = z.object({
  reconciling: z.boolean().optional(),
  containers: z.array(z.object({ image: z.string().optional(), ports: z.array(z.unknown()).optional() })).optional(),
  conditions: z.array(conditionSchema).optional(),
});
export type CloudRunRevision = z.output<typeof cloudRunRevisionSchema>;

/** An image the build pushed (`Build.results.images[]`). */
export interface BuiltImage {
  name?: string | undefined;
  digest?: string | undefined;
}

export interface ImageRef {
  repo: string;
  tag?: string;
  digest?: string;
}

/** `repo[:tag][@digest]`; a `:` before the last `/` is a registry port, not a tag. */
export function parseImageRef(ref: string): ImageRef {
  const at = ref.indexOf("@");
  const digest = at >= 0 ? ref.slice(at + 1) : undefined;
  const rest = at >= 0 ? ref.slice(0, at) : ref;
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  const out: ImageRef = colon > slash ? { repo: rest.slice(0, colon), tag: rest.slice(colon + 1) } : { repo: rest };
  if (digest !== undefined) out.digest = digest;
  return out;
}

const FULL_REVISION_NAME = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/services\/[a-z0-9-]+\/revisions\/([^/]+)$/;

/** A revision's id from its short name or its full resource name (the API gives either); anything else is rejected. */
export function revisionId(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const id = name.includes("/") ? FULL_REVISION_NAME.exec(name)?.[1] : name;
  return id && CLOUD_RUN_REVISION_PATTERN.test(id) ? id : undefined;
}

/** Images the build pushed, keeping only well-formed digests. No images means the build deployed nothing we can see. */
export function pushedImages(images: readonly BuiltImage[] | undefined): { digests: Set<string>; repos: Set<string> } {
  const digests = new Set<string>();
  const repos = new Set<string>();
  for (const img of images ?? []) {
    if (!img.digest || !DIGEST_PATTERN.test(img.digest)) continue;
    digests.add(img.digest);
    if (img.name) repos.add(parseImageRef(img.name).repo);
  }
  return { digests, repos };
}

/**
 * The revision serving 100% of traffic, or why there isn't one. Only `trafficStatuses` (what is actually routed,
 * not the requested `traffic`) counts.
 */
export function servingRevision(service: CloudRunService): { revision: string } | { reason: "not-updated" | "split-traffic" } {
  const serving = (service.trafficStatuses ?? []).filter((t) => (t.percent ?? 0) > 0);
  if (serving.length === 0) return { reason: "not-updated" };
  if (serving.length > 1 || serving[0]!.percent !== 100) return { reason: "split-traffic" };
  const t = serving[0]!;
  const name = t.revision || (t.type === "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" ? service.latestReadyRevision : undefined);
  const revision = revisionId(name);
  return revision ? { revision } : { reason: "not-updated" };
}

export const revisionReady = (rev: CloudRunRevision): boolean =>
  rev.reconciling !== true && (rev.conditions ?? []).some((c) => c.type === "Ready" && c.state === "CONDITION_SUCCEEDED");

/**
 * Whether the revision's serving container runs this build's image for `sha`. A pinned digest must equal one the build
 * pushed (a digest that doesn't match is a different image, whatever its tag). Without a digest, the tag must be the
 * full or short (7+) SHA and the repository one the build pushed to.
 */
export function imageMatch(rev: CloudRunRevision, sha: string, pushed: { digests: Set<string>; repos: Set<string> }): "digest" | "tag" | undefined {
  const one = (image: string | undefined): "digest" | "tag" | undefined => {
    if (!image) return undefined;
    const ref = parseImageRef(image);
    if (ref.digest !== undefined) return pushed.digests.has(ref.digest) ? "digest" : undefined;
    return ref.tag && SHORT_SHA_PATTERN.test(ref.tag) && sha.startsWith(ref.tag) && pushed.repos.has(ref.repo) ? "tag" : undefined;
  };
  const containers = rev.containers ?? [];
  // The container serving requests must be this build's: the one with ports, or the only one. A matching sidecar
  // (whose image may be byte-identical across commits) proves nothing about the app.
  const withPorts = containers.filter((c) => (c.ports?.length ?? 0) > 0);
  const ingress = withPorts.length === 1 ? withPorts[0] : containers.length === 1 ? containers[0] : undefined;
  const via = one(ingress?.image);
  if (!via) return undefined;
  // And no other container may run an older image from a repository this build pushed to.
  for (const c of containers) {
    if (c === ingress || !c.image) continue;
    if (pushed.repos.has(parseImageRef(c.image).repo) && !one(c.image)) return undefined;
  }
  return via;
}

/** Puts the checks together, given what was read. Pure, so every branch is tested without HTTP. */
export async function liveness(
  sha: string,
  images: readonly BuiltImage[] | undefined,
  readService: () => Promise<CloudRunService>,
  readRevision: (id: string) => Promise<CloudRunRevision>,
): Promise<ReleaseLiveness> {
  const pushed = pushedImages(images);
  // Checked before any Cloud Run read: a build that pushed nothing can't have deployed this commit.
  if (pushed.digests.size === 0) return { state: "not-live", reason: "no-artifact", final: true };
  const service = await readService();
  if (service.reconciling === true) return { state: "not-live", reason: "not-ready", final: false };
  const serving = servingRevision(service);
  if ("reason" in serving) return { state: "not-live", reason: serving.reason, final: false };
  const rev = await readRevision(serving.revision);
  if (!revisionReady(rev)) return { state: "not-live", reason: "not-ready", final: false };
  const via = imageMatch(rev, sha, pushed);
  return via ? { state: "live", via } : { state: "not-live", reason: "not-updated", final: false };
}
