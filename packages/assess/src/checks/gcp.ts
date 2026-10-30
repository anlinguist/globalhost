// GCP facts (opt-in with --gcp-project): Cloud Build triggers, Cloud Run services, Firestore databases, and
// whether committed service-account keys are still active. Read-only `gcloud … list --format=json` calls under
// the owner's own login. The schemas keep names, branches and URLs only: substitutions and environment
// variables (which can hold secrets) are stripped at parse time.
import { z } from "zod";
import { gcloudFailure, listed, unavailable, type Exec, type Listing } from "../common.js";
import type { ServiceAccountKeyRef } from "./secrets.js";

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const BranchFilter = z.object({ branch: z.string().optional(), tag: z.string().optional() }).partial();
const TriggerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
  filename: z.string().optional(),
  github: z
    .object({ owner: z.string().optional(), name: z.string().optional(), push: BranchFilter.optional(), pullRequest: BranchFilter.optional() })
    .optional(),
  repositoryEventConfig: z
    .object({ repository: z.string().optional(), push: BranchFilter.optional(), pullRequest: BranchFilter.optional() })
    .optional(),
  triggerTemplate: z.object({ branchName: z.string().optional(), repoName: z.string().optional() }).optional(),
});

const ServiceSchema = z.object({
  metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()).optional() }),
  status: z.object({ url: z.string().optional(), latestReadyRevisionName: z.string().optional() }).optional(),
  spec: z
    .object({
      template: z.object({ spec: z.object({ containers: z.array(z.object({ image: z.string().optional() })).optional() }).optional() }).optional(),
    })
    .optional(),
});

const DatabaseSchema = z.object({ name: z.string(), type: z.string().optional(), locationId: z.string().optional() });
const KeySchema = z.object({ name: z.string(), keyType: z.string().optional(), disabled: z.boolean().optional() });

export interface Trigger {
  id: string;
  name: string;
  disabled: boolean;
  /** "owner/name" for GitHub-connected triggers, else the source repository's name, if known. */
  repo?: string;
  /** Branch regexes that start a build on push, and on pull requests. */
  pushBranch?: string;
  pullRequestBranch?: string;
  /** The build config file, e.g. cloudbuild.yaml. */
  filename?: string;
}

export interface Service {
  name: string;
  region?: string;
  url?: string;
  image?: string;
}

export interface Database {
  name: string;
  type?: string;
  location?: string;
}

export interface GcpFacts {
  project: string;
  triggers: Listing<Trigger>;
  services: Listing<Service>;
  firestore: Listing<Database>;
}

export interface KeyStatus {
  path: string;
  commit: string;
  clientEmail: string;
  /** true: the key is listed and enabled; false: deleted or disabled; undefined: couldn't check. */
  active?: boolean;
  reason?: string;
}

const MAX = 100;

async function gcloudList<T>(exec: Exec, args: string[], schema: z.ZodType<T>): Promise<Listing<T>> {
  let stdout: string;
  try {
    ({ stdout } = await exec("gcloud", [...args, "--format=json", "--quiet"], { timeoutMs: 120_000 }));
  } catch (err) {
    return unavailable(gcloudFailure(err));
  }
  try {
    return listed(z.array(schema).parse(JSON.parse(stdout)), MAX);
  } catch {
    return unavailable(`unexpected output from gcloud ${args.slice(0, 3).join(" ")}`);
  }
}

export async function gcpFacts(project: string, exec: Exec): Promise<GcpFacts> {
  if (!PROJECT.test(project)) throw new Error(`not a GCP project id: ${project}`);
  const p = ["--project", project];
  const triggers = await gcloudList(exec, ["builds", "triggers", "list", ...p], TriggerSchema);
  const services = await gcloudList(exec, ["run", "services", "list", ...p], ServiceSchema);
  const firestore = await gcloudList(exec, ["firestore", "databases", "list", ...p], DatabaseSchema);
  return {
    project,
    triggers: mapListing(triggers, (t) => ({
      id: t.id,
      name: t.name ?? t.id,
      disabled: t.disabled ?? false,
      repo: t.github?.owner && t.github.name ? `${t.github.owner}/${t.github.name}` : (t.repositoryEventConfig?.repository ?? t.triggerTemplate?.repoName),
      pushBranch: t.github?.push?.branch ?? t.repositoryEventConfig?.push?.branch ?? t.triggerTemplate?.branchName,
      pullRequestBranch: t.github?.pullRequest?.branch ?? t.repositoryEventConfig?.pullRequest?.branch,
      filename: t.filename,
    })),
    services: mapListing(services, (s) => ({
      name: s.metadata.name,
      region: s.metadata.labels?.["cloud.googleapis.com/location"],
      url: s.status?.url,
      image: s.spec?.template?.spec?.containers?.[0]?.image,
    })),
    firestore: mapListing(firestore, (d) => ({ name: d.name.replace(/^projects\/[^/]+\/databases\//, ""), type: d.type, location: d.locationId })),
  };
}

function mapListing<A, B>(l: Listing<A>, f: (a: A) => B): Listing<B> {
  return l.ok ? { ok: true, items: l.items.map(f), truncated: l.truncated } : l;
}

/** Asks IAM whether each committed key is still listed and enabled (ONBOARDING: "checks whether the key ID is still active"). */
export async function keyStatuses(keys: readonly ServiceAccountKeyRef[], exec: Exec): Promise<KeyStatus[]> {
  const out: KeyStatus[] = [];
  for (const k of keys) {
    const base = { path: k.path, commit: k.commit, clientEmail: k.clientEmail };
    const listedKeys = await gcloudList(exec, ["iam", "service-accounts", "keys", "list", "--iam-account", k.clientEmail], KeySchema);
    if (!listedKeys.ok) {
      out.push({ ...base, reason: listedKeys.reason });
      continue;
    }
    const match = listedKeys.items.find((x) => x.name.endsWith(`/keys/${k.keyId}`));
    out.push({ ...base, active: match !== undefined && match.disabled !== true });
  }
  return out;
}
