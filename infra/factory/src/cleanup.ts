// Cleanup identity (PLAN P1-13 slice 2, ADR-0020): the factory repo's cleanup.yml on main acts as
// sa:globalhost-gh-cleanup. A workflow file of its own, because `job_workflow_ref` names a file, not a job.
//
// On the control bucket it reads, and can write only under reviews/ and spend/. The grants on each product's dev
// project (the preview service's traffic, and the authorized domains) are made beside those resources, in
// previews.ts. Nothing on a prod project, on globalhost-runs, or on images.
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { FactoryConfig } from "./config.js";
import { factoryWorkflowCondition } from "./nightly.js";

export const CLEANUP_WORKFLOW = ".github/workflows/cleanup.yml";
export const CLEANUP_PROVIDER_ID = "globalhost-cleanup";
export const CLEANUP_ACCOUNT_ID = "globalhost-gh-cleanup";
/** Claims and empty ledgers, which it deletes. A ledger with a review in it is kept by the code, not by IAM. */
export const REVIEWS_PREFIX = "reviews/";
/** Spend records: it rewrites a day's record to release a hold. Also the lifecycle rule's prefix on the control bucket. */
export const SPEND_PREFIX = "spend/";

export const cleanupProviderCondition = (config: FactoryConfig, factoryRepoName: string) => factoryWorkflowCondition(config, factoryRepoName, CLEANUP_WORKFLOW);

/** One object prefix. The trailing slash is the point: `reviews-x` doesn't match. */
export function cleanupObjectCondition(bucket: string, prefix: string): string {
  return `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${prefix}")`;
}

export interface CleanupInputs {
  config: FactoryConfig;
  factoryRepoName: string;
  pool: gcp.iam.WorkloadIdentityPool;
  control: gcp.storage.Bucket;
  afterApis: pulumi.CustomResourceOptions;
}

export function createCleanup({ config, factoryRepoName, pool, control, afterApis }: CleanupInputs) {
  const { project } = config;
  const provider = new gcp.iam.WorkloadIdentityPoolProvider(
    "cleanup-provider",
    {
      project,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: CLEANUP_PROVIDER_ID,
      displayName: "globalhost cleanup",
      description: `Factory repo main, ${CLEANUP_WORKFLOW} only -> sa:${CLEANUP_ACCOUNT_ID}`,
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository_id": "assertion.repository_id",
        "attribute.cleanup": "assertion.repository_id",
      },
      attributeCondition: cleanupProviderCondition(config, factoryRepoName),
    },
    afterApis,
  );

  const sa = new gcp.serviceaccount.Account(
    "gh-cleanup",
    {
      project,
      accountId: CLEANUP_ACCOUNT_ID,
      displayName: "globalhost cleanup (factory repo's cleanup.yml)",
      description: "Sweeps closed PRs' preview tags and authorized domains in dev projects, and their review state in globalhost-control.",
    },
    afterApis,
  );
  const member = pulumi.interpolate`serviceAccount:${sa.email}`;

  // Only the cleanup provider maps attribute.cleanup, so no other provider's token can match this binding.
  new gcp.serviceaccount.IAMMember("gh-cleanup-wif", {
    serviceAccountId: sa.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.cleanup/${config.factoryRepoId}`,
  });

  // Listing is on the bucket, not an object, so this one can't be limited by an object-name condition.
  new gcp.storage.BucketIAMMember("gh-cleanup-control-read", { bucket: control.name, role: "roles/storage.objectViewer", member });
  new gcp.storage.BucketIAMMember("gh-cleanup-control-reviews", {
    bucket: control.name,
    role: "roles/storage.objectUser", // delete claims and empty ledgers; rewrite a ledger to release a hold
    member,
    condition: { title: "review-objects", expression: control.name.apply((b) => cleanupObjectCondition(b, REVIEWS_PREFIX)) },
  });
  new gcp.storage.BucketIAMMember("gh-cleanup-control-spend", {
    bucket: control.name,
    role: "roles/storage.objectUser", // overwriting a record needs delete as well as create; IAM can't separate them
    member,
    condition: { title: "spend-objects", expression: control.name.apply((b) => cleanupObjectCondition(b, SPEND_PREFIX)) },
  });

  return { member, serviceAccount: sa.email, workloadIdentityProvider: provider.name };
}
