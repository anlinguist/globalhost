// Hosted previews (PLAN P1-11, ARCHITECTURE §2.6, ADR-0007 as amended by ADR-0016).
//
// Factory side (globalhost-factory): the image registry the access-guard sidecar is published to, and the WIF
// providers for the image workflow and each product's preview workflow.
// Edge (Cloudflare, `globalhost.ai`): wildcard DNS, the router Worker and its route, one Access application
// for the owner plus a service token for CI screenshots.
// Per product (its `<product>-dev` project only): preview image registry, deployer and runtime identities,
// one `<product>-<part>-preview` Cloud Run service per hosted part, the public screenshot bucket, and the
// Access service token as secrets. Nothing here has any role on a prod project.
import * as cloudflare from "@pulumi/cloudflare";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import type { CloudflareConfig, FactoryConfig, PreviewProduct } from "./config.js";

export const IMAGES_REPO = "globalhost-images";
export const IMAGES_PROVIDER_ID = "globalhost-images";
export const IMAGE_WORKFLOW = ".github/workflows/access-guard-image.yml";
/** The product repo's deploy/teardown workflow. It runs from the default branch (workflow_run, pull_request_target). */
export const PREVIEW_WORKFLOW = ".github/workflows/globalhost-preview.yml";
/** GitHub environments that pick the identity: deploying, and screenshotting (which runs a browser on PR code). */
export const DEPLOY_ENVIRONMENT = "preview-deploy";
export const SCREENSHOT_ENVIRONMENT = "preview-screenshots";
export const ROUTER_SCRIPT = "globalhost-preview-router";
/** The port Cloud Run sends traffic to (the guard) and the one the app listens on behind it. */
export const GUARD_PORT = 8080;
export const APP_PORT = 3000;
export const GUARD_HEALTH_PATH = "/__guard/healthz";
/**
 * Runs as the app container until the first preview deploy replaces it. It must listen on APP_PORT by itself: Cloud
 * Run reserves PORT, and the guard owns 8080. Each deploy resets command and args to the app image's own.
 */
export const PLACEHOLDER_APP_IMAGE = "mirror.gcr.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
export const PLACEHOLDER_APP_ARGS = ["httpd", "-f", "-p", String(APP_PORT), "-h", "/tmp"];

export const PREVIEW_DEV_APIS = [
  "artifactregistry.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "identitytoolkit.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "storage.googleapis.com",
] as const;

export const previewProviderId = (p: PreviewProduct) => `${p.product}-preview`;
export const previewServiceName = (p: PreviewProduct, part: string) => `${p.product}-${part}-preview`;
export const screenshotBucketName = (p: PreviewProduct) => `${p.devProject}-previews`;

/** Cloud Run's deterministic service host; tagged revisions are `<tag>---<this>`. */
export function serviceBaseHost(service: string, projectNumber: string, region: string): string {
  return `${service}-${projectNumber}.${region}.run.app`;
}

/** A GitHub user ID list as a CEL list literal. IDs are validated numeric, so nothing here can inject. */
const celList = (ids: readonly string[]) => `[${ids.map((id) => `'${id}'`).join(", ")}]`;

/**
 * Only the factory repo's image workflow on main may push images. `job_workflow_ref` pins the workflow file, so
 * another workflow on main (or a PR) can't mint this identity.
 */
export function imagesProviderCondition(config: FactoryConfig, factoryRepoName: string): string {
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.repository_id == '${config.factoryRepoId}'`,
    `assertion.ref == 'refs/heads/main'`,
    `assertion.job_workflow_ref == '${factoryRepoName}/${IMAGE_WORKFLOW}@refs/heads/main'`,
  ].join(" && ");
}

/**
 * A product's preview identities: only the default branch's copy of the preview workflow (pinned by
 * `job_workflow_ref`), so no PR can change what runs with them. It runs on `workflow_run` after the credential-free
 * PR build, where the actor must be the owner or the factory bot, or on `pull_request_target` for teardown (it only
 * removes things, so anyone closing a PR may trigger it). The job's environment picks the identity.
 */
export function previewProviderCondition(config: FactoryConfig, p: PreviewProduct): string {
  const ref = `refs/heads/${p.repo.defaultBranch}`;
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.repository_id == '${p.repo.id}'`,
    `assertion.ref == '${ref}'`,
    `assertion.job_workflow_ref == '${p.repo.name}/${PREVIEW_WORKFLOW}@${ref}'`,
    `assertion.runner_environment == 'github-hosted'`,
    `assertion.environment in ['${DEPLOY_ENVIRONMENT}', '${SCREENSHOT_ENVIRONMENT}']`,
    `(assertion.event_name == 'pull_request_target' || (assertion.event_name == 'workflow_run' && assertion.actor_id in ${celList(config.previewActorIds)}))`,
  ].join(" && ");
}

export interface PreviewInputs {
  config: FactoryConfig;
  factoryRepoName: string;
  pool: gcp.iam.WorkloadIdentityPool;
  afterApis: pulumi.CustomResourceOptions;
  /** Absent until the owner sets it; then the edge (DNS, Worker, Access) is created. */
  cloudflare?: pulumi.Output<CloudflareConfig>;
  /** The built router (packages/preview-router/dist/index.js): one self-contained ES module. */
  routerScript: string;
}

export function createPreviews({ config, factoryRepoName, pool, afterApis, cloudflare: cf, routerScript }: PreviewInputs) {
  const { project, region } = config;
  const labels = { system: "globalhost", "managed-by": "pulumi" };

  // ── Factory: access-guard image registry + its publisher ──────────────────────────────────────────
  const images = new gcp.artifactregistry.Repository(
    "images",
    {
      project,
      location: region,
      repositoryId: IMAGES_REPO,
      format: "DOCKER",
      description: "Factory-built images (access-guard). Pulled by product dev projects' Cloud Run.",
      cleanupPolicyDryRun: false,
      // Tagged images are kept: the pinned accessGuardImage must never be deleted from under the services.
      cleanupPolicies: [
        { id: "keep-newest-10", action: "KEEP", mostRecentVersions: { keepCount: 10 } },
        { id: "untagged-30d", action: "DELETE", condition: { tagState: "UNTAGGED", olderThan: "2592000s" } },
      ],
      labels,
    },
    afterApis,
  );

  const imagesProvider = new gcp.iam.WorkloadIdentityPoolProvider(
    "images-provider",
    {
      project,
      workloadIdentityPoolId: pool.workloadIdentityPoolId,
      workloadIdentityPoolProviderId: IMAGES_PROVIDER_ID,
      displayName: "globalhost image publisher",
      description: `Factory repo main, ${IMAGE_WORKFLOW} only -> sa:globalhost-image-publisher`,
      oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
      attributeMapping: {
        "google.subject": "assertion.sub",
        "attribute.repository_id": "assertion.repository_id",
        "attribute.images": "assertion.repository_id",
      },
      attributeCondition: imagesProviderCondition(config, factoryRepoName),
    },
    afterApis,
  );
  const publisher = new gcp.serviceaccount.Account(
    "image-publisher",
    {
      project,
      accountId: "globalhost-image-publisher",
      displayName: "globalhost image publisher (access-guard-image.yml on main)",
      description: "Pushes to Artifact Registry globalhost-images. Nothing else.",
    },
    afterApis,
  );
  new gcp.serviceaccount.IAMMember("image-publisher-wif", {
    serviceAccountId: publisher.name,
    role: "roles/iam.workloadIdentityUser",
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.images/${config.factoryRepoId}`,
  });
  new gcp.artifactregistry.RepositoryIamMember("image-publisher-push", {
    project,
    location: region,
    repository: images.name,
    role: "roles/artifactregistry.writer",
    member: pulumi.interpolate`serviceAccount:${publisher.email}`,
  });

  // ── Edge: Access + service token (needed by every product's services and secrets) ─────────────────
  const edge = cf ? createEdge(cf) : undefined;

  // ── Per product, in its dev project ──────────────────────────────────────────────────────────────
  const products = config.previews.map((p) => createProductPreview(p));

  // The Worker is created last: its service map is the products' Cloud Run hosts.
  if (cf && edge) {
    const services = pulumi
      .all(products.map((x) => x.serviceHosts))
      .apply((maps) => JSON.stringify(Object.assign({}, ...maps)));
    const script = new cloudflare.WorkersScript("preview-router", {
      accountId: cf.accountId,
      scriptName: ROUTER_SCRIPT,
      content: routerScript,
      mainModule: "index.js",
      compatibilityDate: "2026-10-01",
      bindings: [{ type: "plain_text", name: "PREVIEW_SERVICES", text: services }],
      observability: { enabled: true },
    });
    new cloudflare.WorkersRoute("preview-route", {
      zoneId: cf.zoneId,
      pattern: pulumi.interpolate`*.${cf.zone}/*`,
      script: script.scriptName,
    });
  }

  return {
    imagesRepository: pulumi.interpolate`${region}-docker.pkg.dev/${project}/${images.name}`,
    imagePublisherServiceAccount: publisher.email,
    imagesWorkloadIdentityProvider: imagesProvider.name,
    previews: pulumi.all(products.map((x) => x.outputs)),
    previewProjectNumbers: pulumi.all(products.map((x) => x.projectNumber)),
  };

  function createEdge(c: pulumi.Output<CloudflareConfig>) {
    // Proxied wildcard with no real origin: the Worker route answers every request.
    new cloudflare.DnsRecord("preview-wildcard", {
      zoneId: c.zoneId,
      name: pulumi.interpolate`*.${c.zone}`,
      type: "AAAA",
      content: "100::",
      proxied: true,
      ttl: 1,
      comment: "globalhost previews: answered by the preview-router Worker (Pulumi infra/factory)",
    });
    const ownerPolicy = new cloudflare.ZeroTrustAccessPolicy("preview-owner", {
      accountId: c.accountId,
      name: "globalhost previews: owner",
      decision: "allow",
      includes: c.ownerEmails.apply((emails) => emails.map((email) => ({ email: { email } }))),
      sessionDuration: "24h",
    });
    const token = new cloudflare.ZeroTrustAccessServiceToken("preview-ci", {
      accountId: c.accountId,
      name: "globalhost preview CI (screenshots)",
      duration: "8760h",
    });
    const tokenPolicy = new cloudflare.ZeroTrustAccessPolicy("preview-ci", {
      accountId: c.accountId,
      name: "globalhost previews: CI service token",
      decision: "non_identity",
      includes: [{ serviceToken: { tokenId: token.id } }],
    });
    // One application and one CI token for every preview host. With a second product, a product's screenshot
    // token would open the other's previews too: give each product its own application and token then. The future
    // app.globalhost.ai PWA must get its own application (a different AUD) so a preview's JWT can't be replayed
    // there, and a route that excludes it from the Worker.
    const app = new cloudflare.ZeroTrustAccessApplication("previews", {
      accountId: c.accountId,
      name: "globalhost previews",
      type: "self_hosted",
      domain: pulumi.interpolate`*.${c.zone}`,
      sessionDuration: "24h",
      appLauncherVisible: false,
      policies: [
        { id: ownerPolicy.id, precedence: 1 },
        { id: tokenPolicy.id, precedence: 2 },
      ],
    });
    return { aud: app.aud, teamDomain: c.teamDomain, tokenClientId: token.clientId, tokenClientSecret: token.clientSecret };
  }

  function createProductPreview(p: PreviewProduct) {
    const dev = p.devProject;
    const devNumber = gcp.organizations.getProjectOutput({ projectId: dev }).number;
    const n = (s: string) => `${p.product}-${s}`;

    const apis = PREVIEW_DEV_APIS.map(
      (service) => new gcp.projects.Service(n(`api-${service.split(".")[0]}`), { project: dev, service, disableOnDestroy: false }),
    );
    const afterDevApis: pulumi.CustomResourceOptions = { dependsOn: apis };

    const repo = new gcp.artifactregistry.Repository(
      n("preview-images"),
      {
        project: dev,
        location: region,
        repositoryId: "previews",
        format: "DOCKER",
        description: "Preview app images. Untagged after 1 day and anything after 30 days is deleted.",
        cleanupPolicyDryRun: false,
        cleanupPolicies: [
          { id: "untagged-1d", action: "DELETE", condition: { tagState: "UNTAGGED", olderThan: "86400s" } },
          { id: "older-than-30d", action: "DELETE", condition: { tagState: "ANY", olderThan: "2592000s" } },
        ],
        labels,
      },
      afterDevApis,
    );

    // Identities. The deployer is what the PR workflow becomes; the runtime is what preview code runs as.
    const deployer = new gcp.serviceaccount.Account(
      n("preview-deployer"),
      {
        project: dev,
        accountId: "preview-deployer",
        displayName: `${p.repo.name} preview workflow`,
        description: "Pushes preview images, deploys tagged revisions, registers preview hosts in Firebase Auth (dev only).",
      },
      afterDevApis,
    );
    const deployerMember = pulumi.interpolate`serviceAccount:${deployer.email}`;
    const runtime = new gcp.serviceaccount.Account(
      n("preview-runtime"),
      {
        project: dev,
        accountId: "preview-runtime",
        displayName: `${p.product} preview runtime`,
        description: "What preview app code runs as: dev Firestore only.",
      },
      afterDevApis,
    );
    const runtimeMember = pulumi.interpolate`serviceAccount:${runtime.email}`;
    // A separate identity for the screenshot job: it runs a browser on PR code, so it holds only the Access
    // token and write access to the screenshot bucket, never deploy rights.
    const screenshotter = new gcp.serviceaccount.Account(
      n("preview-screenshots"),
      {
        project: dev,
        accountId: "preview-screenshots",
        displayName: `${p.repo.name} preview screenshots`,
        description: "Reads the Access CI token and writes screenshots. Nothing else.",
      },
      afterDevApis,
    );
    const screenshotterMember = pulumi.interpolate`serviceAccount:${screenshotter.email}`;

    const provider = new gcp.iam.WorkloadIdentityPoolProvider(
      n("preview-provider"),
      {
        project,
        workloadIdentityPoolId: pool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: previewProviderId(p),
        displayName: `${p.product} previews`,
        description: `${p.repo.name} ${PREVIEW_WORKFLOW} on ${p.repo.defaultBranch} only -> ${dev} preview identities`,
        oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
        attributeMapping: {
          "google.subject": "assertion.sub",
          "attribute.repository_id": "assertion.repository_id",
          "attribute.actor_id": "assertion.actor_id",
          // Repo and job environment: the deploy job and the screenshot job get different identities.
          "attribute.preview": "assertion.repository_id + '@' + assertion.environment",
        },
        attributeCondition: previewProviderCondition(config, p),
      },
      afterApis,
    );
    for (const [sa, env] of [
      [deployer, DEPLOY_ENVIRONMENT],
      [screenshotter, SCREENSHOT_ENVIRONMENT],
    ] as const) {
      new gcp.serviceaccount.IAMMember(n(`${env}-wif`), {
        serviceAccountId: sa.name,
        role: "roles/iam.workloadIdentityUser",
        member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.preview/${p.repo.id}@${env}`,
      });
    }

    new gcp.artifactregistry.RepositoryIamMember(n("deployer-push"), {
      project: dev,
      location: region,
      repository: repo.name,
      role: "roles/artifactregistry.writer",
      member: deployerMember,
    });
    new gcp.serviceaccount.IAMMember(n("deployer-acts-as-runtime"), {
      serviceAccountId: runtime.name,
      role: "roles/iam.serviceAccountUser",
      member: deployerMember,
    });
    // Firebase Auth authorized domains don't take wildcards; the workflow adds and removes each preview host. A
    // custom role, because firebaseauth.admin would also let it read and export every dev user.
    const authDomainsRole = new gcp.projects.IAMCustomRole(
      n("auth-domains-role"),
      {
        project: dev,
        roleId: "globalhostPreviewAuthDomains",
        title: "globalhost preview: authorized domains",
        description: "Read and update the Identity Platform config (authorized domains) only.",
        permissions: ["firebaseauth.configs.get", "firebaseauth.configs.update"],
      },
      afterDevApis,
    );
    new gcp.projects.IAMMember(n("deployer-auth-domains"), { project: dev, role: authDomainsRole.name, member: deployerMember });
    new gcp.projects.IAMMember(n("runtime-firestore"), { project: dev, role: "roles/datastore.user", member: runtimeMember });

    // Cloud Run in the dev project pulls the factory's access-guard image.
    new gcp.artifactregistry.RepositoryIamMember(
      n("guard-pull"),
      {
        project,
        location: region,
        repository: images.name,
        role: "roles/artifactregistry.reader",
        member: pulumi.interpolate`serviceAccount:service-${devNumber}@serverless-robot-prod.iam.gserviceaccount.com`,
      },
      afterDevApis,
    );

    // Screenshots: public so PR comments can show them (dev seed data only), deleted after 30 days.
    const shots = new gcp.storage.Bucket(
      n("preview-screenshots"),
      {
        name: screenshotBucketName(p),
        project: dev,
        location: region,
        uniformBucketLevelAccess: true,
        publicAccessPrevention: "inherited",
        lifecycleRules: [{ action: { type: "Delete" }, condition: { age: 30 } }],
        softDeletePolicy: { retentionDurationSeconds: 0 },
        labels,
      },
      afterDevApis,
    );
    // Read objects by URL, but not list the bucket.
    new gcp.storage.BucketIAMMember(n("screenshots-public"), { bucket: shots.name, role: "roles/storage.legacyObjectReader", member: "allUsers" });
    new gcp.storage.BucketIAMMember(n("screenshots-writer"), { bucket: shots.name, role: "roles/storage.objectCreator", member: screenshotterMember });

    // The CI service token, readable by the screenshot identity only (screenshots go through Access like the owner).
    if (edge) {
      for (const [id, value] of [
        ["preview-access-client-id", edge.tokenClientId],
        ["preview-access-client-secret", edge.tokenClientSecret],
      ] as const) {
        const secret = new gcp.secretmanager.Secret(
          n(id),
          { project: dev, secretId: id, replication: { auto: {} }, labels },
          afterDevApis,
        );
        new gcp.secretmanager.SecretVersion(n(`${id}-v`), { secret: secret.id, secretData: pulumi.secret(value) });
        new gcp.secretmanager.SecretIamPolicy(n(`${id}-policy`), {
          project: dev,
          secretId: secret.secretId,
          policyData: pulumi.jsonStringify({ bindings: [{ role: "roles/secretmanager.secretAccessor", members: [screenshotterMember] }] }),
        });
      }
    }

    // One service per hosted part. Each PR deploys a tagged, no-traffic revision that replaces only the `app`
    // container; the guard comes from here. Created once the guard image and the edge (its AUD) exist.
    const serviceHosts: Record<string, pulumi.Output<string>> = {};
    if (edge && config.accessGuardImage) {
      for (const part of p.parts) {
        const name = previewServiceName(p, part);
        const service = new gcp.cloudrunv2.Service(
          n(`${part}-preview`),
          {
            project: dev,
            location: region,
            name,
            ingress: "INGRESS_TRAFFIC_ALL",
            deletionProtection: false,
            labels,
            template: {
              serviceAccount: runtime.email,
              scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
              maxInstanceRequestConcurrency: 40,
              timeout: "60s",
              containers: [
                {
                  name: "guard",
                  image: config.accessGuardImage,
                  ports: { containerPort: GUARD_PORT },
                  envs: [
                    { name: "UPSTREAM_PORT", value: String(APP_PORT) },
                    { name: "ACCESS_TEAM_DOMAIN", value: edge.teamDomain },
                    { name: "ACCESS_AUD", value: edge.aud },
                    { name: "HEALTH_PATH", value: GUARD_HEALTH_PATH },
                  ],
                  resources: { limits: { cpu: "1", memory: "256Mi" }, cpuIdle: true },
                  startupProbe: { httpGet: { path: GUARD_HEALTH_PATH, port: GUARD_PORT } },
                },
                {
                  name: "app",
                  image: PLACEHOLDER_APP_IMAGE,
                  args: PLACEHOLDER_APP_ARGS,
                  // The guard starts first and holds 8080, so PR code can never take the ingress port.
                  dependsOns: ["guard"],
                  resources: { limits: { cpu: "1", memory: "1Gi" }, cpuIdle: true },
                  startupProbe: { tcpSocket: { port: APP_PORT }, periodSeconds: 2, failureThreshold: 60 },
                },
              ],
            },
          },
          {
            ...afterDevApis,
            // The preview workflow owns the app container, revisions and tags; Pulumi owns the rest.
            ignoreChanges: [
              "template.containers[1].image",
              "template.containers[1].envs",
              "template.containers[1].commands",
              "template.containers[1].args",
              "template.revision",
              "template.labels",
              "template.annotations",
              "traffics",
              "client",
              "clientVersion",
            ],
          },
        );
        // Anyone may reach the service; the guard rejects every request without a valid Access JWT.
        new gcp.cloudrunv2.ServiceIamMember(n(`${part}-public`), {
          project: dev,
          location: region,
          name: service.name,
          role: "roles/run.invoker",
          member: "allUsers",
        });
        new gcp.cloudrunv2.ServiceIamMember(n(`${part}-deployer`), {
          project: dev,
          location: region,
          name: service.name,
          role: "roles/run.developer",
          member: deployerMember,
        });
        serviceHosts[`${p.product}-${part}`] = pulumi.output(devNumber).apply((num) => serviceBaseHost(name, num, region));
      }
    }

    return {
      projectNumber: devNumber,
      serviceHosts: pulumi.all(serviceHosts),
      outputs: pulumi.output({
        product: p.product,
        devProject: dev,
        workloadIdentityProvider: provider.name,
        deployerServiceAccount: deployer.email,
        screenshotServiceAccount: screenshotter.email,
        runtimeServiceAccount: runtime.email,
        imageRepository: pulumi.interpolate`${region}-docker.pkg.dev/${dev}/${repo.name}`,
        screenshotBucket: shots.name,
        services: pulumi.all(serviceHosts),
      }),
    };
  }
}
