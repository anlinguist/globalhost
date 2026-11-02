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
export const ROUTER_SCRIPT = "globalhost-preview-router";
/** The port Cloud Run sends traffic to (the guard) and the one the app listens on behind it. */
export const GUARD_PORT = 8080;
export const APP_PORT = 3000;
export const GUARD_HEALTH_PATH = "/__guard/healthz";
/** Runs as the app container until the first preview deploy replaces it (it listens on $PORT). */
export const PLACEHOLDER_APP_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

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
 * A product's preview workflow: pull_request events in that repo, triggered by the owner or the factory bot
 * only. A PR from anyone else gets no token, so a changed workflow file in their PR can't deploy anything. The
 * bot can't edit workflows (the App has no `workflows` permission), and the owner reviews workflow changes.
 */
export function previewProviderCondition(config: FactoryConfig, p: PreviewProduct): string {
  return [
    `assertion.repository_owner_id == '${config.githubOwnerId}'`,
    `assertion.repository_id == '${p.repo.id}'`,
    `assertion.event_name == 'pull_request'`,
    `assertion.actor_id in ${celList(config.previewActorIds)}`,
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
      description: "Factory-built images (access-guard). Pulled by product dev projects' Cloud Run. Keeps the 5 newest.",
      cleanupPolicyDryRun: false,
      cleanupPolicies: [
        { id: "keep-newest-5", action: "KEEP", mostRecentVersions: { keepCount: 5 } },
        { id: "delete-older-than-30d", action: "DELETE", condition: { tagState: "ANY", olderThan: "2592000s" } },
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
    // One application for every preview host. The future app.globalhost.ai PWA must get its own application
    // (a different AUD) so a preview's JWT can't be replayed there, and a route that excludes it from the Worker.
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
        description: "Preview app images. Untagged after 1 day and anything after 14 days is deleted.",
        cleanupPolicyDryRun: false,
        cleanupPolicies: [
          { id: "untagged-1d", action: "DELETE", condition: { tagState: "UNTAGGED", olderThan: "86400s" } },
          { id: "older-than-14d", action: "DELETE", condition: { tagState: "ANY", olderThan: "1209600s" } },
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

    const provider = new gcp.iam.WorkloadIdentityPoolProvider(
      n("preview-provider"),
      {
        project,
        workloadIdentityPoolId: pool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: previewProviderId(p),
        displayName: `${p.product} previews`,
        description: `${p.repo.name} pull_request events by the owner or factory bot -> ${dev} preview-deployer`,
        oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
        attributeMapping: {
          "google.subject": "assertion.sub",
          "attribute.repository_id": "assertion.repository_id",
          "attribute.actor_id": "assertion.actor_id",
          "attribute.preview": "assertion.repository_id",
        },
        attributeCondition: previewProviderCondition(config, p),
      },
      afterApis,
    );
    new gcp.serviceaccount.IAMMember(n("preview-deployer-wif"), {
      serviceAccountId: deployer.name,
      role: "roles/iam.workloadIdentityUser",
      member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.preview/${p.repo.id}`,
    });

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
    // Firebase Auth authorized domains don't take wildcards; the workflow adds and removes each preview host.
    new gcp.projects.IAMMember(n("deployer-auth-domains"), { project: dev, role: "roles/firebaseauth.admin", member: deployerMember });
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
    new gcp.storage.BucketIAMMember(n("screenshots-public"), { bucket: shots.name, role: "roles/storage.objectViewer", member: "allUsers" });
    new gcp.storage.BucketIAMMember(n("screenshots-deployer"), { bucket: shots.name, role: "roles/storage.objectCreator", member: deployerMember });

    // The CI service token, readable by the deployer only (screenshots go through Access like the owner does).
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
          policyData: pulumi.jsonStringify({ bindings: [{ role: "roles/secretmanager.secretAccessor", members: [deployerMember] }] }),
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
                  dependsOns: ["app"],
                },
                {
                  name: "app",
                  image: PLACEHOLDER_APP_IMAGE,
                  envs: [{ name: "PORT", value: String(APP_PORT) }],
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
        runtimeServiceAccount: runtime.email,
        imageRepository: pulumi.interpolate`${region}-docker.pkg.dev/${dev}/${repo.name}`,
        screenshotBucket: shots.name,
        services: pulumi.all(serviceHosts),
      }),
    };
  }
}
