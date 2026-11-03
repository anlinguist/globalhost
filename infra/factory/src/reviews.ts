// Reviewer identity (PLAN P2-01, ADR-0018): product repos' `globalhost-review.yml`, on the default branch, in the
// `globalhost-review` environment, acts as sa:globalhost-gh-review. Separate from sa:gh-dispatch so a review job
// can't reach the builder's control objects (locks, kill switch writes) or any other repo's review state, and
// separate in Anthropic too (its own federation rule, set up in the Console; ADR-0014).
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { DispatchRepo, FactoryConfig } from "./config.js";

export const REVIEW_WORKFLOW = ".github/workflows/globalhost-review.yml";
export const REVIEW_PROVIDER_ID = "globalhost-review";
export const REVIEW_ACCOUNT_ID = "globalhost-gh-review";

/** The single attribute sa:globalhost-gh-review is bound on. Only the review provider maps it. */
export function reviewAttributeValue(repo: DispatchRepo, environment: string): string {
  return `${repo.id}@${environment}`;
}

/**
 * Only the default branch's copy of the review workflow (both `job_workflow_ref` and `workflow_ref`, so no other
 * workflow can call it and get the token), for its two triggers, in the review environment, on a GitHub-hosted
 * runner. `ref` is the default branch for `workflow_run` and the base branch for `pull_request_target`, so a PR
 * into another branch is refused too. A PR can't change what runs with this identity.
 */
export function reviewProviderCondition(config: FactoryConfig): string {
  const repoClauses = config.reviewRepos
    .map((r) => {
      const ref = `refs/heads/${r.defaultBranch}`;
      const wf = `${r.name}/${REVIEW_WORKFLOW}@${ref}`;
      return (
        `(assertion.repository_id == '${r.id}' && assertion.ref == '${ref}' && ` +
        `assertion.job_workflow_ref == '${wf}' && assertion.workflow_ref == '${wf}')`
      );
    })
    .join(" || ");
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.environment == '${config.reviewEnvironment}'`,
    `assertion.runner_environment == 'github-hosted'`,
    `assertion.event_name in ['workflow_run', 'pull_request_target']`,
    `(${repoClauses})`,
  ].join(" && ");
}

const objectPrefix = (bucket: string, prefix: string) => `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${prefix}")`;

/**
 * Control bucket, read/write/delete (claims and the PR ledger are compare-and-swap): each review repo's
 * `reviews/<owner>/<name>/` (lowercased, as packages/dispatch writes it) and its daily spend records
 * `spend/<day>/<owner>__<name>.json`, which reviews share with builders. Nothing else: not `state.json`, `locks/`,
 * or another repo's objects.
 */
export function reviewControlCondition(config: FactoryConfig, bucket: string): string {
  return config.reviewRepos
    .map((r) => {
      const spend = `resource.name.endsWith("/${r.name.replace("/", "__")}.json")`;
      return `${objectPrefix(bucket, `reviews/${r.name.toLowerCase()}/`)} || (${objectPrefix(bucket, "spend/")} && ${spend})`;
    })
    .join(" || ");
}

/** Runs bucket, create only: each review repo's `<owner>/<name>/reviews/` archive (lowercased). */
export function reviewRunsCondition(config: FactoryConfig, bucket: string): string {
  return config.reviewRepos.map((r) => objectPrefix(bucket, `${r.name.toLowerCase()}/reviews/`)).join(" || ");
}

export interface ReviewInputs {
  config: FactoryConfig;
  pool: gcp.iam.WorkloadIdentityPool;
  control: gcp.storage.Bucket;
  runs: gcp.storage.Bucket;
  controlStateObject: string;
  afterApis: pulumi.CustomResourceOptions;
}

/** Nothing is created until a repo is listed in `reviewRepos`. Returns the member to add to the App key's policy. */
export function createReviewer({ config, pool, control, runs, controlStateObject, afterApis }: ReviewInputs) {
  if (config.reviewRepos.length === 0) return undefined;
  const { project } = config;
  // WIF's limit on a provider's attribute condition; fail at preview rather than at apply.
  if (reviewProviderCondition(config).length > 4096) throw new Error("reviewRepos: too many repos for one review provider's condition");

  const provider = new gcp.iam.WorkloadIdentityPoolProvider(
    "review-provider",
    {
      project,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: REVIEW_PROVIDER_ID,
      displayName: "globalhost reviewer",
      description: `Product repos' ${REVIEW_WORKFLOW} on the default branch (environment-scoped) -> sa:${REVIEW_ACCOUNT_ID}`,
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository_id": "assertion.repository_id",
        "attribute.environment": "assertion.environment",
        "attribute.review": "assertion.repository_id + '@' + assertion.environment",
      },
      attributeCondition: reviewProviderCondition(config),
    },
    afterApis,
  );

  const sa = new gcp.serviceaccount.Account(
    "gh-review",
    {
      project,
      accountId: REVIEW_ACCOUNT_ID,
      displayName: "globalhost reviewer (product repos' globalhost-review.yml)",
      description: "Review claims/ledgers and spend in globalhost-control, review archives in globalhost-runs, the App key.",
    },
    afterApis,
  );
  const member = pulumi.interpolate`serviceAccount:${sa.email}`;

  config.reviewRepos.forEach((repo) => {
    new gcp.serviceaccount.IAMMember(`gh-review-wif-${repo.id}`, {
      serviceAccountId: sa.name,
      role: "roles/iam.workloadIdentityUser",
      member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.review/${reviewAttributeValue(repo, config.reviewEnvironment)}`,
    });
  });

  // Bucket-level and conditioned on object names. No project-level role.
  new gcp.storage.BucketIAMMember("gh-review-control-rw", {
    bucket: control.name,
    role: "roles/storage.objectUser",
    member,
    condition: { title: "review-and-spend-objects", expression: control.name.apply((b) => reviewControlCondition(config, b)) },
  });
  new gcp.storage.BucketIAMMember("gh-review-control-state", {
    bucket: control.name,
    role: "roles/storage.objectViewer", // the kill switch: read state.json, never write it
    member,
    condition: {
      title: "state-object-read",
      expression: pulumi.interpolate`resource.name == "projects/_/buckets/${control.name}/objects/${controlStateObject}"`,
    },
  });
  new gcp.storage.BucketIAMMember("gh-review-runs-create", {
    bucket: runs.name,
    role: "roles/storage.objectCreator", // create-only archive; no read, overwrite or delete
    member,
    condition: { title: "review-archives", expression: runs.name.apply((b) => reviewRunsCondition(config, b)) },
  });

  return { member, serviceAccount: sa.email, workloadIdentityProvider: provider.name };
}
