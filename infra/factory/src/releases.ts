// Release observation (PLAN P1-12, ADR-0017): after a merge to a product's default branch, the product repo's
// `globalhost-release.yml` reads the Cloud Build build for the merge commit and reports it on the PR and issue.
// The only factory identity with any role on a prod project, and it can only read builds, triggers and the Cloud Run
// service it checks the merged commit is live on (ADR-0019). The product's prod Cloud Build triggers are imported
// here too, so their config is reviewed in PRs and only changes through the owner's `pulumi up`.
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { FactoryConfig, ReleaseObserver, ReleaseTrigger } from "./config.js";

export const RELEASE_WORKFLOW = ".github/workflows/globalhost-release.yml";
/**
 * Read builds and triggers (trigger reads use cloudbuild.builds.get), and get (not list) Cloud Run services and
 * revisions to confirm a successful build is actually serving. Not logs, not IAM policies, not projects, not anything
 * else; no `.list` on Cloud Run, since the observer only ever reads the one service named in factory.yaml.
 */
export const RELEASE_OBSERVER_PERMISSIONS = ["cloudbuild.builds.get", "cloudbuild.builds.list", "run.revisions.get", "run.services.get"] as const;

export const releaseProviderId = (r: ReleaseObserver) => `${r.product}-release`;
export const releaseObserverAccountId = (r: ReleaseObserver) => `${r.product}-release-observer`;

/**
 * Only the default branch's copy of the release workflow, on a push to that branch, on a GitHub-hosted runner. A
 * PR can't change what runs with this identity, and no other event or workflow can mint it.
 */
export function releaseProviderCondition(config: FactoryConfig, r: ReleaseObserver): string {
  const ref = `refs/heads/${r.repo.defaultBranch}`;
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.repository_id == '${r.repo.id}'`,
    `assertion.event_name == 'push'`,
    `assertion.ref == '${ref}'`,
    `assertion.job_workflow_ref == '${r.repo.name}/${RELEASE_WORKFLOW}@${ref}'`,
    // The top-level workflow too: if the release file ever became callable (workflow_call), job_workflow_ref would
    // name it even when another workflow called it.
    `assertion.workflow_ref == '${r.repo.name}/${RELEASE_WORKFLOW}@${ref}'`,
    `assertion.runner_environment == 'github-hosted'`,
  ].join(" && ");
}

/**
 * A product's prod Cloud Build trigger, exactly as it exists (ADR-0019): GitHub push on the branch, building the
 * repo's config file. No `build` (inline steps) and no service account override: neither is configurable.
 */
export function releaseTriggerArgs(r: ReleaseObserver, t: ReleaseTrigger): gcp.cloudbuild.TriggerArgs {
  const [owner, name] = r.repo.name.split("/") as [string, string];
  return {
    project: r.prodProject,
    location: "global",
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    disabled: t.disabled,
    filename: t.filename,
    github: { owner, name, push: { branch: t.branch } },
    substitutions: { ...t.substitutions, _SERVICE_NAME: t.service },
    tags: t.tags,
  };
}

/**
 * Imported, never created: the trigger already exists, and `pulumi up` adopts it only if the live config matches.
 * Protected so a config edit can't delete the trigger that deploys prod. The import ID is ignored once it's in state.
 */
export function releaseTriggerOptions(r: ReleaseObserver, t: ReleaseTrigger): pulumi.CustomResourceOptions {
  return { import: `projects/${r.prodProject}/locations/global/triggers/${t.id}`, protect: true };
}

export interface ReleaseInputs {
  config: FactoryConfig;
  pool: gcp.iam.WorkloadIdentityPool;
  afterApis: pulumi.CustomResourceOptions;
}

export function createReleaseObservers({ config, pool, afterApis }: ReleaseInputs) {
  const { project } = config;
  const observers = config.releaseObservers.map((r) => {
    const n = (s: string) => `${r.product}-${s}`;
    const provider = new gcp.iam.WorkloadIdentityPoolProvider(
      n("release-provider"),
      {
        project,
        workloadIdentityPoolId: pool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: releaseProviderId(r),
        displayName: `${r.product} release observer`,
        description: `${r.repo.name} ${RELEASE_WORKFLOW} on push to ${r.repo.defaultBranch} -> read ${r.prodProject} builds`,
        oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
        attributeMapping: {
          "google.subject": "assertion.sub",
          "attribute.repository_id": "assertion.repository_id",
          "attribute.release": "assertion.repository_id",
        },
        attributeCondition: releaseProviderCondition(config, r),
      },
      afterApis,
    );
    // The identity lives in the factory project; its one grant is on the prod project.
    const sa = new gcp.serviceaccount.Account(
      n("release-observer"),
      {
        project,
        accountId: releaseObserverAccountId(r),
        displayName: `${r.product} release observer`,
        description: `Reads Cloud Build builds and triggers and Cloud Run services in ${r.prodProject}. Nothing else.`,
      },
      afterApis,
    );
    new gcp.serviceaccount.IAMMember(n("release-observer-wif"), {
      serviceAccountId: sa.name,
      role: "roles/iam.workloadIdentityUser",
      member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.release/${r.repo.id}`,
    });
    const role = new gcp.projects.IAMCustomRole(n("release-observer-role"), {
      project: r.prodProject,
      roleId: "globalhostReleaseObserver",
      title: "globalhost release observer",
      description:
        "Read Cloud Build builds and triggers and get Cloud Run services and revisions, for globalhost's post-merge deploy report. Managed by globalhost infra/factory.",
      permissions: [...RELEASE_OBSERVER_PERMISSIONS],
    });
    new gcp.projects.IAMMember(n("release-observer-grant"), {
      project: r.prodProject,
      role: role.name,
      member: pulumi.interpolate`serviceAccount:${sa.email}`,
    });
    for (const t of r.triggers) {
      new gcp.cloudbuild.Trigger(n(`trigger-${t.key}`), releaseTriggerArgs(r, t), releaseTriggerOptions(r, t));
    }
    return pulumi.output({
      product: r.product,
      prodProject: r.prodProject,
      workloadIdentityProvider: provider.name,
      serviceAccount: sa.email,
    });
  });
  return { releaseObservers: pulumi.all(observers) };
}
