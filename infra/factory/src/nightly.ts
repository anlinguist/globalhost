// Nightly identity (PLAN P1-13, ADR-0020): the factory repo's nightly.yml on main acts as sa:globalhost-gh-nightly.
// It reads the runs and control buckets to build the metrics, and can write only under metrics/ in the control
// bucket. No other write anywhere: it can't touch the ledger, the kill switch, locks or run artifacts.
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { FactoryConfig } from "./config.js";

export const NIGHTLY_WORKFLOW = ".github/workflows/nightly.yml";
export const NIGHTLY_PROVIDER_ID = "globalhost-nightly";
export const NIGHTLY_ACCOUNT_ID = "globalhost-gh-nightly";
/** The only prefix it can write. Also the lifecycle rule's prefix on the control bucket. */
export const METRICS_PREFIX = "metrics/";

/**
 * Only main's copy of one scheduled workflow in the factory repo (both `job_workflow_ref` and `workflow_ref`, so no
 * other workflow can call it and get the token), for `schedule` and `workflow_dispatch`, on a GitHub-hosted runner.
 */
export function factoryWorkflowCondition(config: FactoryConfig, factoryRepoName: string, workflow: string): string {
  const ref = "refs/heads/main";
  const wf = `${factoryRepoName}/${workflow}@${ref}`;
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.repository_id == '${config.factoryRepoId}'`,
    `assertion.ref == '${ref}'`,
    `assertion.job_workflow_ref == '${wf}'`,
    `assertion.workflow_ref == '${wf}'`,
    `assertion.event_name in ['schedule', 'workflow_dispatch']`,
    `assertion.runner_environment == 'github-hosted'`,
  ].join(" && ");
}

export const nightlyProviderCondition = (config: FactoryConfig, factoryRepoName: string) => factoryWorkflowCondition(config, factoryRepoName, NIGHTLY_WORKFLOW);

/** The object prefix it can write. The trailing slash is the point: `metrics-x` doesn't match. */
export function nightlyMetricsCondition(bucket: string): string {
  return `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${METRICS_PREFIX}")`;
}

export interface NightlyInputs {
  config: FactoryConfig;
  factoryRepoName: string;
  pool: gcp.iam.WorkloadIdentityPool;
  control: gcp.storage.Bucket;
  runs: gcp.storage.Bucket;
  afterApis: pulumi.CustomResourceOptions;
}

export function createNightly({ config, factoryRepoName, pool, control, runs, afterApis }: NightlyInputs) {
  const { project } = config;
  const provider = new gcp.iam.WorkloadIdentityPoolProvider(
    "nightly-provider",
    {
      project,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: NIGHTLY_PROVIDER_ID,
      displayName: "globalhost nightly",
      description: `Factory repo main, ${NIGHTLY_WORKFLOW} only -> sa:${NIGHTLY_ACCOUNT_ID}`,
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository_id": "assertion.repository_id",
        "attribute.nightly": "assertion.repository_id",
      },
      attributeCondition: nightlyProviderCondition(config, factoryRepoName),
    },
    afterApis,
  );

  const sa = new gcp.serviceaccount.Account(
    "gh-nightly",
    {
      project,
      accountId: NIGHTLY_ACCOUNT_ID,
      displayName: "globalhost nightly (factory repo's nightly.yml)",
      description: "Reads globalhost-runs and globalhost-control; writes only metrics/ in globalhost-control.",
    },
    afterApis,
  );
  const member = pulumi.interpolate`serviceAccount:${sa.email}`;

  // Only the nightly provider maps attribute.nightly, so no other provider's token can match this binding.
  new gcp.serviceaccount.IAMMember("gh-nightly-wif", {
    serviceAccountId: sa.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.nightly/${config.factoryRepoId}`,
  });

  // Bucket-level. Nothing at project level.
  new gcp.storage.BucketIAMMember("gh-nightly-runs-read", { bucket: runs.name, role: "roles/storage.objectViewer", member });
  new gcp.storage.BucketIAMMember("gh-nightly-control-read", { bucket: control.name, role: "roles/storage.objectViewer", member });
  new gcp.storage.BucketIAMMember("gh-nightly-control-metrics", {
    bucket: control.name,
    role: "roles/storage.objectUser", // overwriting a day's report needs delete as well as create
    member,
    condition: { title: "metrics-objects", expression: control.name.apply(nightlyMetricsCondition) },
  });

  return { serviceAccount: sa.email, workloadIdentityProvider: provider.name };
}
