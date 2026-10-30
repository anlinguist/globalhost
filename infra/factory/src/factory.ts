// Factory GCP infrastructure in `globalhost-factory` (PLAN P1-04, ARCHITECTURE §5).
//
// Not managed here (chicken-and-egg, see infra/bootstrap/pulumi-state.sh): the state bucket
// gs://globalhost-pulumi-state and the KMS key that encrypts this stack's secrets.
// Not built (ADR-0011, ADR-0014): runner Cloud Run Job, runner image registry, sa:runner, any
// Anthropic key. The dispatcher talks to Anthropic with its own GitHub OIDC token.
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { DispatchRepo, FactoryConfig } from "./config.js";

export const RUNS_BUCKET = "globalhost-runs";
export const CONTROL_BUCKET = "globalhost-control";
export const CONTROL_STATE_OBJECT = "state.json";
export const GITHUB_APP_KEY_SECRET = "github-app-key";
export const BUDGET_DISPLAY_NAME = "globalhost-factory-monthly";
export const DISPATCH_PROVIDER_ID = "globalhost-dispatch";

export const REQUIRED_APIS = [
  "artifactregistry.googleapis.com", // image store for the budget function's build (Cloud Functions 2nd gen)
  "billingbudgets.googleapis.com",
  "cloudbuild.googleapis.com",
  "cloudfunctions.googleapis.com",
  "cloudkms.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "eventarc.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "logging.googleapis.com",
  "pubsub.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "storage.googleapis.com",
  "sts.googleapis.com",
] as const;

export interface FunctionSource {
  archive: pulumi.asset.Archive;
  /** Content hash; part of the object name so a code change redeploys the function. */
  hash: string;
}

export interface FactoryInputs {
  config: FactoryConfig;
  billingAccount: pulumi.Input<string>;
  budgetPauseSource: FunctionSource;
}

/** The single attribute sa:gh-dispatch is bound on. Only the dispatch provider maps it. */
export function dispatchAttributeValue(repo: DispatchRepo, environment: string): string {
  return `${repo.id}@${environment}`;
}

/**
 * Provider condition: tokens from repos owned by the pinned owner ID, from one of the listed repo IDs
 * on that repo's default branch, in the dispatch environment. Everything else is rejected at the STS
 * exchange, before any IAM binding is consulted.
 */
export function dispatchProviderCondition(config: FactoryConfig): string {
  const repoClauses = config.dispatchRepos
    .map((r) => `(assertion.repository_id == '${r.id}' && assertion.ref == 'refs/heads/${r.defaultBranch}')`)
    .join(" || ");
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.environment == '${config.dispatchEnvironment}'`,
    `(${repoClauses})`,
  ].join(" && ");
}

export function createFactory({ config, billingAccount, budgetPauseSource }: FactoryInputs) {
  const { project, region } = config;
  const projectInfo = gcp.organizations.getProjectOutput({ projectId: project });
  const projectNumber = projectInfo.number;

  // ── APIs ────────────────────────────────────────────────────────────────────────────────────────
  const apis = REQUIRED_APIS.map(
    (service) =>
      new gcp.projects.Service(`api-${service.split(".")[0]}`, { project, service, disableOnDestroy: false }),
  );
  const afterApis: pulumi.CustomResourceOptions = { dependsOn: apis };

  // ── Buckets ─────────────────────────────────────────────────────────────────────────────────────
  const labels = { system: "globalhost", "managed-by": "pulumi" };
  const runs = new gcp.storage.Bucket(
    "runs",
    {
      name: RUNS_BUCKET,
      project,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      // Run artifacts are transient: archived bundles and run.json age out after 30 days.
      lifecycleRules: [{ action: { type: "Delete" }, condition: { age: 30 } }],
      softDeletePolicy: { retentionDurationSeconds: 0 },
      labels,
    },
    afterApis,
  );

  const control = new gcp.storage.Bucket(
    "control",
    {
      name: CONTROL_BUCKET,
      project,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      // state.json and locks change often; versions give an audit trail of pause/resume and spend.
      versioning: { enabled: true },
      lifecycleRules: [
        { action: { type: "Delete" }, condition: { withState: "ARCHIVED", daysSinceNoncurrentTime: 30 } },
        { action: { type: "Delete" }, condition: { withState: "ARCHIVED", numNewerVersions: 100 } },
      ],
      softDeletePolicy: { retentionDurationSeconds: 0 },
      labels,
    },
    afterApis,
  );

  // ── Workload Identity Federation ────────────────────────────────────────────────────────────────
  // The pool `github` already exists (infra/bootstrap/security-audit.sh). Import it rather than
  // creating a second pool; its `github-actions` provider stays owned by that script for now.
  const pool = new gcp.iam.WorkloadIdentityPool(
    "github-pool",
    { project, workloadIdentityPoolId: config.wifPoolId, displayName: config.wifPoolDisplayName },
    {
      ...afterApis,
      import: `projects/${project}/locations/global/workloadIdentityPools/${config.wifPoolId}`,
      protect: true,
    },
  );

  // A separate provider in the same pool: the audit provider is pinned to the factory repo's main
  // branch, this one to product repos' dispatcher jobs. Bindings use `attribute.dispatch`, which only
  // this provider maps, so audit-provider tokens can never match a dispatch binding (and vice versa).
  const dispatchProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    "dispatch-provider",
    {
      project,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: DISPATCH_PROVIDER_ID,
      displayName: "globalhost dispatcher",
      description: "Product-repo dispatcher jobs (environment-scoped) -> sa:globalhost-gh-dispatch",
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository": "assertion.repository",
        "attribute.repository_id": "assertion.repository_id",
        "attribute.environment": "assertion.environment",
        "attribute.dispatch": "assertion.repository_id + '@' + assertion.environment",
      },
      attributeCondition: dispatchProviderCondition(config),
    },
    afterApis,
  );

  // ── Service accounts ────────────────────────────────────────────────────────────────────────────
  const ghDispatch = new gcp.serviceaccount.Account(
    "gh-dispatch",
    {
      project,
      accountId: "globalhost-gh-dispatch",
      displayName: "globalhost dispatcher (product repos' globalhost.yml)",
      description: "Kill switch/spend/locks in globalhost-control, run artifacts in globalhost-runs, the App key.",
    },
    afterApis,
  );
  const ghDispatchMember = pulumi.interpolate`serviceAccount:${ghDispatch.email}`;

  config.dispatchRepos.forEach((repo) => {
    new gcp.serviceaccount.IAMMember(`gh-dispatch-wif-${repo.id}`, {
      serviceAccountId: ghDispatch.name,
      role: "roles/iam.workloadIdentityUser",
      member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.dispatch/${dispatchAttributeValue(repo, config.dispatchEnvironment)}`,
    });
  });

  // gh-dispatch: bucket- and secret-level only. No project-level role.
  new gcp.storage.BucketIAMMember("gh-dispatch-control-rw", {
    bucket: control.name,
    role: "roles/storage.objectUser", // read/write/delete: state.json, spend, lock objects (CAS via generation match)
    member: ghDispatchMember,
  });
  new gcp.storage.BucketIAMMember("gh-dispatch-runs-create", {
    bucket: runs.name,
    role: "roles/storage.objectCreator", // archive bundle + run.json; no overwrite or delete
    member: ghDispatchMember,
  });
  new gcp.storage.BucketIAMMember("gh-dispatch-runs-read", {
    bucket: runs.name,
    role: "roles/storage.objectViewer",
    member: ghDispatchMember,
  });

  // ── Secret: GitHub App private key (value added by the owner via infra/github-app) ─────────────
  const appKey = new gcp.secretmanager.Secret(
    "github-app-key",
    {
      project,
      secretId: GITHUB_APP_KEY_SECRET,
      replication: { auto: {} },
      deletionProtection: true,
      labels,
    },
    afterApis,
  );
  // Authoritative: this is the secret's entire IAM policy, so nothing else can be granted on it
  // out of band without showing up as drift.
  new gcp.secretmanager.SecretIamPolicy("github-app-key-policy", {
    project,
    secretId: appKey.secretId,
    policyData: pulumi.jsonStringify({
      bindings: [{ role: "roles/secretmanager.secretAccessor", members: [ghDispatchMember] }],
    }),
  });

  // ── Budget → Pub/Sub → budget-pause function ───────────────────────────────────────────────────
  const budgetTopic = new gcp.pubsub.Topic(
    "budget-alerts",
    { project, name: "globalhost-budget-alerts", messageRetentionDuration: "86400s", labels },
    afterApis,
  );
  // Cloud Billing publishes as this Google-managed account.
  new gcp.pubsub.TopicIAMMember("budget-alerts-billing-publisher", {
    project,
    topic: budgetTopic.name,
    role: "roles/pubsub.publisher",
    member: "serviceAccount:billing-budget-alert@system.gserviceaccount.com",
  });

  // Runtime identity of the function, also used as the Eventarc trigger identity.
  const pauseSa = new gcp.serviceaccount.Account(
    "budget-pause",
    {
      project,
      accountId: "globalhost-budget-pause",
      displayName: "globalhost budget-pause function",
      description: "Sets paused=true in gs://globalhost-control/state.json at 100% of the factory budget.",
    },
    afterApis,
  );
  const pauseMember = pulumi.interpolate`serviceAccount:${pauseSa.email}`;
  new gcp.storage.BucketIAMMember("budget-pause-control-state", {
    bucket: control.name,
    role: "roles/storage.objectUser",
    member: pauseMember,
    condition: {
      title: "state-object-only",
      expression: pulumi.interpolate`resource.name == "projects/_/buckets/${control.name}/objects/${CONTROL_STATE_OBJECT}"`,
    },
  });

  // Build identity for the function (instead of the over-privileged default compute account).
  const buildSa = new gcp.serviceaccount.Account(
    "functions-build",
    { project, accountId: "globalhost-fn-build", displayName: "globalhost Cloud Functions builds" },
    afterApis,
  );
  const buildMember = pulumi.interpolate`serviceAccount:${buildSa.email}`;
  const buildLogs = new gcp.projects.IAMMember("functions-build-logs", {
    project,
    role: "roles/logging.logWriter",
    member: buildMember,
  });
  // Cloud Functions copies the source into its own staging bucket before building, and a custom build
  // identity must be able to read it. That bucket is Google-created (on first deploy), so the grant is
  // project-level but conditioned on that one bucket's name: no access to control, runs or anything else.
  const stagingBucket = pulumi.interpolate`gcf-v2-sources-${projectNumber}-${region}`;
  const buildStaging = new gcp.projects.IAMMember("functions-build-staging", {
    project,
    role: "roles/storage.objectViewer",
    member: buildMember,
    condition: {
      title: "gcf-v2-sources only",
      // The bucket itself or its objects; an exact prefix so a lookalike name doesn't match.
      expression: pulumi.interpolate`resource.name == "projects/_/buckets/${stagingBucket}" || resource.name.startsWith("projects/_/buckets/${stagingBucket}/")`,
    },
  });

  // Function images. Cloud Functions 2nd gen always builds a container; this repo replaces the
  // auto-created `gcf-artifacts` one so a cleanup policy applies (cheap by default).
  const functionImages = new gcp.artifactregistry.Repository(
    "function-images",
    {
      project,
      location: region,
      repositoryId: "globalhost-functions",
      format: "DOCKER",
      description: "Cloud Functions build output (budget-pause). Keeps the 2 newest versions.",
      cleanupPolicyDryRun: false,
      cleanupPolicies: [
        { id: "keep-newest-2", action: "KEEP", mostRecentVersions: { keepCount: 2 } },
        { id: "delete-older-than-7d", action: "DELETE", condition: { tagState: "ANY", olderThan: "604800s" } },
      ],
      labels,
    },
    afterApis,
  );
  const buildImages = new gcp.artifactregistry.RepositoryIamMember("functions-build-images", {
    project,
    location: region,
    repository: functionImages.name,
    role: "roles/artifactregistry.writer",
    member: buildMember,
  });

  // Function source. Pulumi owns the single object and deletes the previous one when the hash changes,
  // so there is nothing for a lifecycle rule to clean up.
  const sourceBucket = new gcp.storage.Bucket(
    "function-source",
    {
      name: "globalhost-functions-source",
      project,
      location: region,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
      softDeletePolicy: { retentionDurationSeconds: 0 },
      labels,
    },
    afterApis,
  );
  const buildSource = new gcp.storage.BucketIAMMember("functions-build-source", {
    bucket: sourceBucket.name,
    role: "roles/storage.objectViewer",
    member: buildMember,
  });
  const sourceObject = new gcp.storage.BucketObject("budget-pause-source", {
    bucket: sourceBucket.name,
    name: `budget-pause-${budgetPauseSource.hash}.zip`,
    source: budgetPauseSource.archive,
  });

  const pauseFunction = new gcp.cloudfunctionsv2.Function(
    "budget-pause",
    {
      project,
      location: region,
      name: "globalhost-budget-pause",
      description: "Pauses the factory when the GCP budget reaches 100%",
      buildConfig: {
        runtime: "nodejs24",
        entryPoint: "budgetPause",
        serviceAccount: buildSa.id,
        dockerRepository: functionImages.id,
        source: { storageSource: { bucket: sourceBucket.name, object: sourceObject.name } },
      },
      serviceConfig: {
        serviceAccountEmail: pauseSa.email,
        minInstanceCount: 0,
        maxInstanceCount: 1,
        availableMemory: "256M",
        timeoutSeconds: 60,
        ingressSettings: "ALLOW_INTERNAL_ONLY",
        allTrafficOnLatestRevision: true,
        environmentVariables: {
          CONTROL_BUCKET: control.name,
          STATE_OBJECT: CONTROL_STATE_OBJECT,
          BUDGET_DISPLAY_NAME,
        },
      },
      eventTrigger: {
        triggerRegion: region,
        eventType: "google.cloud.pubsub.topic.v1.messagePublished",
        pubsubTopic: budgetTopic.id,
        // A failed write must be retried, or a 100% notification could be lost.
        retryPolicy: "RETRY_POLICY_RETRY",
        serviceAccountEmail: pauseSa.email,
      },
    },
    // The build fails (and leaves a FAILED function behind) if it starts before its identity can act.
    { dependsOn: [...apis, buildLogs, buildStaging, buildImages, buildSource] },
  );
  // The trigger identity may invoke only this function's service.
  new gcp.cloudrunv2.ServiceIamMember("budget-pause-invoker", {
    project,
    location: region,
    // A function whose first build failed has no service; say so rather than bind to "".
    name: pauseFunction.serviceConfig.apply((s) => {
      if (!s?.service) throw new Error("globalhost-budget-pause has no Cloud Run service (failed build?); delete it, `pulumi refresh`, and re-run");
      return s.service;
    }),
    role: "roles/run.invoker",
    member: pauseMember,
  });

  // Created after the function: Pub/Sub drops messages published before the trigger's subscription exists.
  new gcp.billing.Budget(
    "factory-budget",
    {
      billingAccount,
      displayName: BUDGET_DISPLAY_NAME,
      budgetFilter: {
        projects: [pulumi.interpolate`projects/${projectNumber}`],
        calendarPeriod: "MONTH",
        creditTypesTreatment: "INCLUDE_ALL_CREDITS",
      },
      amount: { specifiedAmount: { currencyCode: "USD", units: String(config.monthlyBudgetUsd) } },
      thresholdRules: config.budgetThresholds.map((thresholdPercent) => ({
        thresholdPercent,
        spendBasis: "CURRENT_SPEND",
      })),
      allUpdatesRule: { pubsubTopic: budgetTopic.id, schemaVersion: "1.0" },
    },
    { dependsOn: [...apis, pauseFunction] },
  );

  return {
    projectNumber,
    runsBucket: runs.name,
    controlBucket: control.name,
    controlStateObject: CONTROL_STATE_OBJECT,
    ghDispatchServiceAccount: ghDispatch.email,
    workloadIdentityProvider: dispatchProvider.name,
    githubAppKeySecret: appKey.id,
    budgetTopic: budgetTopic.id,
    budgetPauseFunction: pauseFunction.name,
  };
}
