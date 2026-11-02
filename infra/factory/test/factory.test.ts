import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFactoryConfig } from "../src/config.js";
import {
  BUDGET_DISPLAY_NAME,
  CONTROL_BUCKET,
  GITHUB_APP_KEY_SECRET,
  RUNS_BUCKET,
  createFactory,
  dispatchProviderCondition,
} from "../src/factory.js";
import { imagesProviderCondition, previewProviderCondition } from "../src/previews.js";
import { releaseProviderCondition } from "../src/releases.js";

interface Registered {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const PROJECT = "globalhost-factory";
const PROJECT_NUMBER = "123456789012";
const DEV_PROJECT = "numu-know-dev";
const PROD_PROJECT = "numu-know";
const DEV_PROJECT_NUMBER = "414694776649";
const GUARD_IMAGE = `us-central1-docker.pkg.dev/${PROJECT}/globalhost-images/access-guard@sha256:${"b".repeat(64)}`;
const resources: Registered[] = [];

/** Mocks see secret inputs as `{ <specialSigKey>: <secret sig>, value }`; tests compare the plain values. */
function unwrapSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapSecrets);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (pulumi.runtime.specialSigKey in o) return unwrapSecrets(o.value);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, unwrapSecrets(x)]));
  }
  return v;
}

pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push({ type: args.type, name: args.name, inputs: unwrapSecrets(args.inputs) as Record<string, unknown> });
      const state: Record<string, unknown> = { ...args.inputs };
      switch (args.type) {
        case "gcp:serviceaccount/account:Account": {
          const project = String(args.inputs.project ?? PROJECT);
          const email = `${String(args.inputs.accountId)}@${project}.iam.gserviceaccount.com`;
          state.email = email;
          state.name = `projects/${project}/serviceAccounts/${email}`;
          return { id: state.name as string, state };
        }
        case "gcp:iam/workloadIdentityPool:WorkloadIdentityPool":
          state.name = `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${String(args.inputs.workloadIdentityPoolId)}`;
          break;
        case "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider":
          state.name = `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${String(args.inputs.workloadIdentityPoolId)}/providers/${String(args.inputs.workloadIdentityPoolProviderId)}`;
          break;
        case "gcp:pubsub/topic:Topic":
          return { id: `projects/${PROJECT}/topics/${String(args.inputs.name)}`, state };
        case "gcp:cloudfunctionsv2/function:Function":
          state.serviceConfig = { ...(args.inputs.serviceConfig as object), service: String(args.inputs.name) };
          break;
        case "gcp:projects/iAMCustomRole:IAMCustomRole":
          state.name = `projects/${String(args.inputs.project)}/roles/${String(args.inputs.roleId)}`;
          break;
        case "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication":
          state.aud = "a".repeat(64);
          break;
        case "cloudflare:index/zeroTrustAccessServiceToken:ZeroTrustAccessServiceToken":
          state.clientId = "client-id.access";
          state.clientSecret = "client-secret";
          break;
      }
      return { id: `${args.name}-id`, state };
    },
    call(args) {
      if (args.token === "gcp:organizations/getProject:getProject") {
        const projectId = String(args.inputs.projectId);
        return { number: projectId === DEV_PROJECT ? DEV_PROJECT_NUMBER : PROJECT_NUMBER, projectId };
      }
      throw new Error(`unmocked call ${args.token}`);
    },
  },
  "globalhost-factory",
  "prod",
  false,
);

const config = parseFactoryConfig({
  project: PROJECT,
  region: "us-central1",
  githubOwnerId: "47403803",
  dispatchRepos: [{ name: "anlinguist/numu-know", id: "338675328", defaultBranch: "main" }],
  factoryRepoId: "1437394155",
  previews: [{ product: "numu-know", devProject: DEV_PROJECT, repo: { name: "anlinguist/numu-know", id: "338675328", defaultBranch: "main" }, parts: ["web"] }],
  previewActorIds: ["47403803", "350478808"],
  accessGuardImage: GUARD_IMAGE,
  releaseObservers: [{ product: "numu-know", prodProject: PROD_PROJECT, repo: { name: "anlinguist/numu-know", id: "338675328", defaultBranch: "main" } }],
});

const GH_DISPATCH = `serviceAccount:globalhost-gh-dispatch@${PROJECT}.iam.gserviceaccount.com`;

function ofType(type: string): Registered[] {
  return resources.filter((r) => r.type === type);
}
function one(type: string, name: string): Registered {
  const r = resources.find((x) => x.type === type && x.name === name);
  if (!r) throw new Error(`no ${type} named ${name}`);
  return r;
}

beforeAll(async () => {
  const outputs = createFactory({
    config,
    billingAccount: "000000-000000-000000",
    budgetPauseSource: {
      archive: new pulumi.asset.AssetArchive({ "index.js": new pulumi.asset.StringAsset("export {};") }),
      hash: "test",
    },
    factoryRepoName: "anlinguist/globalhost",
    routerScript: "export default { fetch() { return new Response(null, { status: 404 }); } };",
    cloudflare: pulumi.secret({
      accountId: "c".repeat(32),
      zoneId: "d".repeat(32),
      zone: "globalhost.ai",
      teamDomain: "team.cloudflareaccess.com",
      ownerEmails: ["owner@example.com"],
    }),
  });
  // Resolve every output so all resources (and their inputs) have registered.
  await new Promise<void>((resolve) =>
    pulumi.all(Object.values(outputs) as pulumi.Input<unknown>[]).apply(() => {
      resolve();
    }),
  );
  // Child resources registered from .apply callbacks land on the next ticks.
  await new Promise((r) => setTimeout(r, 50));
}, 30_000);

describe("factory infra", () => {
  it("registers resources", () => {
    expect(resources.length).toBeGreaterThan(20);
  });

  it("gives sa:gh-dispatch no project-level role", () => {
    const projectLevel = resources.filter((r) => r.type.startsWith("gcp:projects/iAM"));
    expect(projectLevel.length).toBeGreaterThan(0); // the build SA's log writer, so the filter is live
    for (const r of projectLevel) {
      expect(r.inputs.member).not.toBe(GH_DISPATCH);
      expect(JSON.stringify(r.inputs.members ?? [])).not.toContain("gh-dispatch");
      expect(JSON.stringify(r.inputs.policyData ?? "")).not.toContain("gh-dispatch");
    }
  });

  it("lets the build SA read only Cloud Functions' staging bucket at project level", () => {
    const projectLevel = resources.filter((r) => r.type.startsWith("gcp:projects/iAM") && r.inputs.role === "roles/storage.objectViewer");
    expect(projectLevel).toHaveLength(1);
    const grant = projectLevel[0]!;
    expect(grant.inputs.member).toBe(`serviceAccount:globalhost-fn-build@${PROJECT}.iam.gserviceaccount.com`);
    expect((grant.inputs.condition as { expression: string }).expression).toBe(
      `resource.name == "projects/_/buckets/gcf-v2-sources-${PROJECT_NUMBER}-us-central1" || ` +
        `resource.name.startsWith("projects/_/buckets/gcf-v2-sources-${PROJECT_NUMBER}-us-central1/")`,
    );
  });

  it("grants sa:gh-dispatch exactly its bucket roles, bucket-scoped", () => {
    const grants = ofType("gcp:storage/bucketIAMMember:BucketIAMMember")
      .filter((r) => r.inputs.member === GH_DISPATCH)
      .map((r) => `${String(r.inputs.bucket)} ${String(r.inputs.role)}`)
      .sort();
    expect(grants).toEqual([
      `${CONTROL_BUCKET} roles/storage.objectUser`,
      `${RUNS_BUCKET} roles/storage.objectCreator`,
      `${RUNS_BUCKET} roles/storage.objectViewer`,
    ]);
    // No other kind of grant names it, apart from its own WIF bindings and the secret policy.
    const elsewhere = resources.filter(
      (r) =>
        JSON.stringify(r.inputs).includes("globalhost-gh-dispatch@") &&
        ![
          "gcp:storage/bucketIAMMember:BucketIAMMember",
          "gcp:secretmanager/secretIamPolicy:SecretIamPolicy",
          "gcp:serviceaccount/iAMMember:IAMMember",
        ].includes(r.type),
    );
    expect(elsewhere.map((r) => r.type)).toEqual([]);
  });

  it("lets only the configured repos' dispatch environment impersonate sa:gh-dispatch", () => {
    const bindings = ofType("gcp:serviceaccount/iAMMember:IAMMember").filter((r) =>
      String(r.inputs.serviceAccountId).includes("globalhost-gh-dispatch@"),
    );
    expect(bindings.map((b) => [b.inputs.role, b.inputs.member])).toEqual([
      [
        "roles/iam.workloadIdentityUser",
        `principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.dispatch/338675328@globalhost`,
      ],
    ]);
  });

  it("makes sa:gh-dispatch the only principal on the App key secret, with no version", () => {
    const secret = one("gcp:secretmanager/secret:Secret", "github-app-key");
    expect(secret.inputs.secretId).toBe(GITHUB_APP_KEY_SECRET);
    // Its value is added by the owner; the only versions Pulumi writes are the dev project's preview token.
    expect(ofType("gcp:secretmanager/secretVersion:SecretVersion").map((r) => r.name)).toEqual([
      "numu-know-preview-access-client-id-v",
      "numu-know-preview-access-client-secret-v",
    ]);

    const policies = ofType("gcp:secretmanager/secretIamPolicy:SecretIamPolicy").filter((r) => r.inputs.project === PROJECT);
    expect(policies).toHaveLength(1);
    const policy = JSON.parse(String(policies[0]?.inputs.policyData)) as {
      bindings: { role: string; members: string[]; condition?: unknown }[];
    };
    expect(policy.bindings).toEqual([{ role: "roles/secretmanager.secretAccessor", members: [GH_DISPATCH] }]);
    // No additive grants on any secret.
    expect(resources.filter((r) => /^gcp:secretmanager\/secretIam(Member|Binding)/.test(r.type))).toEqual([]);
  });

  it("expires run artifacts after 30 days and locks both buckets down", () => {
    const runs = one("gcp:storage/bucket:Bucket", "runs");
    expect(runs.inputs.name).toBe(RUNS_BUCKET);
    expect(runs.inputs.lifecycleRules).toEqual([{ action: { type: "Delete" }, condition: { age: 30 } }]);
    for (const name of ["runs", "control", "function-source"]) {
      const b = one("gcp:storage/bucket:Bucket", name);
      expect(b.inputs.uniformBucketLevelAccess).toBe(true);
      expect(b.inputs.publicAccessPrevention).toBe("enforced");
    }
  });

  it("versions the control bucket and expires noncurrent versions", () => {
    const control = one("gcp:storage/bucket:Bucket", "control");
    expect(control.inputs.name).toBe(CONTROL_BUCKET);
    expect(control.inputs.versioning).toEqual({ enabled: true });
    const rules = control.inputs.lifecycleRules as { action: { type: string }; condition: Record<string, unknown> }[];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.action.type).toBe("Delete");
      expect(rule.condition.withState).toBe("ARCHIVED"); // never deletes the live state.json
    }
    expect(rules.some((r) => r.condition.daysSinceNoncurrentTime === 30)).toBe(true);
  });

  it("puts a cleanup policy on the function image repository", () => {
    const repo = one("gcp:artifactregistry/repository:Repository", "function-images");
    expect(repo.inputs.cleanupPolicyDryRun).toBe(false);
    expect(JSON.stringify(repo.inputs.cleanupPolicies)).toContain('"keepCount":2');
  });

  it("imports the existing WIF pool instead of creating a second one", () => {
    expect(ofType("gcp:iam/workloadIdentityPool:WorkloadIdentityPool")).toHaveLength(1);
    expect(one("gcp:iam/workloadIdentityPool:WorkloadIdentityPool", "github-pool").inputs.workloadIdentityPoolId).toBe(
      "github",
    );
  });

  it("pins the dispatch provider to the owner ID, repo IDs, default branch and environment", () => {
    const provider = one("gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "dispatch-provider");
    const condition = String(provider.inputs.attributeCondition);
    expect(condition).toBe(
      "assertion.repository_owner_id == '47403803' && assertion.environment == 'globalhost' && " +
        "((assertion.repository_id == '338675328' && assertion.ref == 'refs/heads/main'))",
    );
    expect(provider.inputs.oidc).toEqual({ issuerUri: "https://token.actions.githubusercontent.com" });
    const mapping = provider.inputs.attributeMapping as Record<string, string>;
    expect(mapping["attribute.dispatch"]).toBe("assertion.repository_id + '@' + assertion.environment");
  });

  it("budgets $25 with 40/80/100% thresholds wired to the pause topic", () => {
    const budget = one("gcp:billing/budget:Budget", "factory-budget");
    expect(budget.inputs.displayName).toBe(BUDGET_DISPLAY_NAME);
    expect(budget.inputs.amount).toEqual({ specifiedAmount: { currencyCode: "USD", units: "25" } });
    expect(
      (budget.inputs.thresholdRules as { thresholdPercent: number }[]).map((t) => t.thresholdPercent),
    ).toEqual([0.4, 0.8, 1.0]);
    // Dev projects share the factory budget (ARCHITECTURE §5.2).
    expect(budget.inputs.budgetFilter).toMatchObject({ projects: [`projects/${PROJECT_NUMBER}`, `projects/${DEV_PROJECT_NUMBER}`] });
    expect(budget.inputs.allUpdatesRule).toMatchObject({
      pubsubTopic: `projects/${PROJECT}/topics/globalhost-budget-alerts`,
    });

    const fn = one("gcp:cloudfunctionsv2/function:Function", "budget-pause");
    expect(fn.inputs.eventTrigger).toMatchObject({
      pubsubTopic: `projects/${PROJECT}/topics/globalhost-budget-alerts`,
      retryPolicy: "RETRY_POLICY_RETRY",
    });
    expect(fn.inputs.buildConfig).toMatchObject({ runtime: "nodejs24", entryPoint: "budgetPause" });
    expect(fn.inputs.serviceConfig).toMatchObject({
      minInstanceCount: 0,
      ingressSettings: "ALLOW_INTERNAL_ONLY",
      environmentVariables: { CONTROL_BUCKET, BUDGET_DISPLAY_NAME },
    });
  });

  it("limits the pause function to the state object", () => {
    const grants = ofType("gcp:storage/bucketIAMMember:BucketIAMMember").filter((r) =>
      String(r.inputs.member).includes("globalhost-budget-pause@"),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.inputs.condition).toMatchObject({
      expression: `resource.name == "projects/_/buckets/${CONTROL_BUCKET}/objects/state.json"`,
    });
  });

  it("creates no runner infrastructure (ADR-0011) and no Anthropic key secret (ADR-0014)", () => {
    expect(ofType("gcp:cloudrunv2/job:Job")).toEqual([]);
    const sas = ofType("gcp:serviceaccount/account:Account").map((r) => r.inputs.accountId);
    expect(sas).not.toContain("runner");
    expect(sas).not.toContain("globalhost-runner");
    const secrets = ofType("gcp:secretmanager/secret:Secret").filter((r) => r.inputs.project === PROJECT).map((r) => r.inputs.secretId);
    expect(secrets).toEqual([GITHUB_APP_KEY_SECRET]);
  });
});

describe("dispatch provider condition", () => {
  it("ORs one clause per repo and keeps the owner and environment pins", () => {
    const multi = parseFactoryConfig({
      ...config,
      dispatchRepos: [
        { name: "anlinguist/a", id: "1", defaultBranch: "main" },
        { name: "anlinguist/b", id: "2", defaultBranch: "trunk" },
      ],
    });
    expect(dispatchProviderCondition(multi)).toBe(
      "assertion.repository_owner_id == '47403803' && assertion.environment == 'globalhost' && " +
        "((assertion.repository_id == '1' && assertion.ref == 'refs/heads/main') || " +
        "(assertion.repository_id == '2' && assertion.ref == 'refs/heads/trunk'))",
    );
  });

  it.each([
    ["a non-numeric owner id", { githubOwnerId: "anlinguist" }],
    ["a quote in a branch (CEL injection)", { dispatchRepos: [{ name: "a/b", id: "1", defaultBranch: "main' || true || '" }] }],
    ["a quote in the environment", { dispatchEnvironment: "x' || true || '" }],
    ["a repo name instead of an id", { dispatchRepos: [{ name: "a/b", id: "a/b", defaultBranch: "main" }] }],
    ["no repos", { dispatchRepos: [] }],
    ["duplicate repo ids", { dispatchRepos: [{ name: "a/b", id: "1", defaultBranch: "main" }, { name: "a/c", id: "1", defaultBranch: "main" }] }],
    ["unknown keys", { extra: true }],
  ])("rejects config with %s", (_name, patch) => {
    expect(() => parseFactoryConfig({ ...config, ...patch })).toThrow();
  });
});

describe("previews (P1-11)", () => {
  const DEPLOYER = `serviceAccount:preview-deployer@${DEV_PROJECT}.iam.gserviceaccount.com`;
  const RUNTIME = `serviceAccount:preview-runtime@${DEV_PROJECT}.iam.gserviceaccount.com`;
  const SHOTS = `serviceAccount:preview-screenshots@${DEV_PROJECT}.iam.gserviceaccount.com`;

  it("pins the preview provider to main's copy of the preview workflow, never a PR's", () => {
    const provider = one("gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "numu-know-preview-provider");
    expect(provider.inputs.attributeCondition).toBe(
      "assertion.repository_owner_id == '47403803' && assertion.repository_id == '338675328' && " +
        "assertion.ref == 'refs/heads/main' && " +
        "assertion.job_workflow_ref == 'anlinguist/numu-know/.github/workflows/globalhost-preview.yml@refs/heads/main' && " +
        "assertion.runner_environment == 'github-hosted' && " +
        "assertion.environment in ['preview-deploy', 'preview-screenshots'] && " +
        "(assertion.event_name == 'pull_request_target' || " +
        "(assertion.event_name == 'workflow_run' && assertion.actor_id in ['47403803', '350478808']))",
    );
    expect((provider.inputs.attributeMapping as Record<string, string>)["attribute.preview"]).toBe(
      "assertion.repository_id + '@' + assertion.environment",
    );
    expect(previewProviderCondition(config, config.previews[0]!)).toBe(provider.inputs.attributeCondition);
  });

  it("lets only the factory repo's image workflow on main publish images", () => {
    expect(imagesProviderCondition(config, "anlinguist/globalhost")).toBe(
      "assertion.repository_owner_id == '47403803' && assertion.repository_id == '1437394155' && " +
        "assertion.ref == 'refs/heads/main' && " +
        "assertion.job_workflow_ref == 'anlinguist/globalhost/.github/workflows/access-guard-image.yml@refs/heads/main'",
    );
  });

  it("touches no prod project except the release observer's read-only role and its one grant", () => {
    const projects = new Set(resources.map((r) => r.inputs.project).filter((p) => p !== undefined));
    expect([...projects].sort()).toEqual([DEV_PROJECT, PROD_PROJECT, PROJECT].sort());
    expect(resources.filter((r) => r.inputs.project === PROD_PROJECT).map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      "gcp:projects/iAMCustomRole:IAMCustomRole numu-know-release-observer-role",
      "gcp:projects/iAMMember:IAMMember numu-know-release-observer-grant",
    ]);
  });

  it("binds each identity to its own job environment", () => {
    const wif = ofType("gcp:serviceaccount/iAMMember:IAMMember").filter((r) => r.inputs.role === "roles/iam.workloadIdentityUser");
    const members = wif.map((r) => String(r.inputs.member)).filter((m) => m.includes("attribute.preview/"));
    expect(members.map((m) => m.split("attribute.preview/")[1]).sort()).toEqual(["338675328@preview-deploy", "338675328@preview-screenshots"]);
  });

  it("gives the deployer, screenshot and runtime identities only their listed roles", () => {
    const roles = (member: string) =>
      resources
        .filter((r) => r.inputs.member === member || (typeof r.inputs.policyData === "string" && r.inputs.policyData.includes(member)))
        .map((r) => `${r.type.split(":")[1]} ${String(r.inputs.role ?? "policy")}`)
        .sort();
    expect(roles(DEPLOYER)).toEqual(
      [
        "artifactregistry/repositoryIamMember roles/artifactregistry.reader",
        "artifactregistry/repositoryIamMember roles/artifactregistry.writer",
        "cloudrunv2/serviceIamMember roles/run.developer",
        "projects/iAMMember projects/numu-know-dev/roles/globalhostPreviewAuthDomains",
        "serviceaccount/iAMMember roles/iam.serviceAccountUser",
      ].sort(),
    );
    expect(roles(SHOTS)).toEqual(
      [
        "secretmanager/secretIamPolicy policy",
        "secretmanager/secretIamPolicy policy",
        "storage/bucketIAMMember roles/storage.objectCreator",
      ].sort(),
    );
    const role = one("gcp:projects/iAMCustomRole:IAMCustomRole", "numu-know-auth-domains-role");
    expect(role.inputs.permissions).toEqual(["firebaseauth.configs.get", "firebaseauth.configs.update"]);
    expect(roles(RUNTIME)).toEqual(["projects/iAMMember roles/datastore.user"]);
  });

  it("puts the guard in front of the app on each preview service", () => {
    const svc = one("gcp:cloudrunv2/service:Service", "numu-know-web-preview");
    expect(svc.inputs.name).toBe("numu-know-web-preview");
    expect(svc.inputs.project).toBe(DEV_PROJECT);
    const template = svc.inputs.template as { serviceAccount: string; scaling: object; containers: Array<Record<string, unknown>> };
    expect(template.scaling).toMatchObject({ minInstanceCount: 0, maxInstanceCount: 1 });
    const [guard, app] = template.containers;
    expect(guard).toMatchObject({ name: "guard", image: GUARD_IMAGE, ports: { containerPort: 8080 } });
    // The guard starts first, so PR code can't take its port; nothing depends on the app.
    expect(guard).not.toHaveProperty("dependsOns");
    expect(guard?.envs).toEqual(
      expect.arrayContaining([
        { name: "UPSTREAM_PORT", value: "3000" },
        { name: "ACCESS_TEAM_DOMAIN", value: "team.cloudflareaccess.com" },
        { name: "ACCESS_AUD", value: "a".repeat(64) },
      ]),
    );
    expect(app).toMatchObject({ name: "app", dependsOns: ["guard"], args: ["httpd", "-f", "-p", "3000", "-h", "/tmp"] });
    // Cloud Run reserves PORT.
    expect(app).not.toHaveProperty("envs");
    expect(app).not.toHaveProperty("ports");
  });

  it("routes the Worker to the deterministic service host behind one owner-only Access app", () => {
    const script = one("cloudflare:index/workersScript:WorkersScript", "preview-router");
    const bindings = script.inputs.bindings as Array<{ name: string; text: string }>;
    expect(JSON.parse(bindings.find((b) => b.name === "PREVIEW_SERVICES")!.text)).toEqual({
      "numu-know-web": `numu-know-web-preview-${DEV_PROJECT_NUMBER}.us-central1.run.app`,
    });
    expect(one("cloudflare:index/workersRoute:WorkersRoute", "preview-route").inputs.pattern).toBe("*.globalhost.ai/*");
    const app = one("cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication", "previews");
    expect(app.inputs.domain).toBe("*.globalhost.ai");
    const owner = one("cloudflare:index/zeroTrustAccessPolicy:ZeroTrustAccessPolicy", "preview-owner");
    expect(owner.inputs).toMatchObject({ decision: "allow", includes: [{ email: { email: "owner@example.com" } }] });
    expect(one("cloudflare:index/zeroTrustAccessPolicy:ZeroTrustAccessPolicy", "preview-ci").inputs.decision).toBe("non_identity");
  });

  it("keeps screenshots public but short-lived", () => {
    const bucket = one("gcp:storage/bucket:Bucket", "numu-know-preview-screenshots");
    expect(bucket.inputs).toMatchObject({ name: "numu-know-dev-previews", project: DEV_PROJECT });
    expect(bucket.inputs.lifecycleRules).toEqual([{ action: { type: "Delete" }, condition: { age: 30 } }]);
    // Readable by URL, not listable.
    expect(one("gcp:storage/bucketIAMMember:BucketIAMMember", "numu-know-screenshots-public").inputs.role).toBe("roles/storage.legacyObjectReader");
  });

  it.each([
    ["a prod (non -dev) preview project", { previews: [{ ...config.previews[0], devProject: "numu-know" }] }],
    ["previews without actor ids", { previewActorIds: [] }],
    ["a quote in an actor id (CEL injection)", { previewActorIds: ["1' || true || '"] }],
    ["a guard image without a digest", { accessGuardImage: "us-central1-docker.pkg.dev/p/r/access-guard:latest" }],
    ["a hyphenated part", { previews: [{ ...config.previews[0], parts: ["web-app"] }] }],
    ["duplicate products", { previews: [config.previews[0], config.previews[0]] }],
    ["a service name too long for a tag URL", { previews: [{ ...config.previews[0], product: "a-very-long-product-name", parts: ["andlongpartname"] }] }],
    ["a quote in the default branch (CEL injection)", { previews: [{ ...config.previews[0], repo: { name: "a/b", id: "1", defaultBranch: "main' || true || '" } }] }],
  ])("rejects config with %s", (_name, patch) => {
    expect(() => parseFactoryConfig({ ...config, ...patch })).toThrow();
  });
});

describe("release observer (P1-12, ADR-0017)", () => {
  it("pins the provider to the default branch's release workflow on push", () => {
    const provider = one("gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider", "numu-know-release-provider");
    expect(provider.inputs.attributeCondition).toBe(
      "assertion.repository_owner_id == '47403803' && assertion.repository_id == '338675328' && " +
        "assertion.event_name == 'push' && assertion.ref == 'refs/heads/main' && " +
        "assertion.job_workflow_ref == 'anlinguist/numu-know/.github/workflows/globalhost-release.yml@refs/heads/main' && " +
        "assertion.workflow_ref == 'anlinguist/numu-know/.github/workflows/globalhost-release.yml@refs/heads/main' && " +
        "assertion.runner_environment == 'github-hosted'",
    );
    expect(releaseProviderCondition(config, config.releaseObservers[0]!)).toBe(provider.inputs.attributeCondition);
  });

  it("can only read builds in the prod project", () => {
    const role = one("gcp:projects/iAMCustomRole:IAMCustomRole", "numu-know-release-observer-role");
    expect(role.inputs).toMatchObject({ project: PROD_PROJECT, permissions: ["cloudbuild.builds.get", "cloudbuild.builds.list"] });
    const grant = one("gcp:projects/iAMMember:IAMMember", "numu-know-release-observer-grant");
    expect(grant.inputs).toMatchObject({
      project: PROD_PROJECT,
      role: "projects/numu-know/roles/globalhostReleaseObserver",
      member: `serviceAccount:numu-know-release-observer@${PROJECT}.iam.gserviceaccount.com`,
    });
    // Its only other binding is the WIF one.
    const member = `serviceAccount:numu-know-release-observer@${PROJECT}.iam.gserviceaccount.com`;
    expect(resources.filter((r) => r.inputs.member === member).map((r) => r.name)).toEqual(["numu-know-release-observer-grant"]);
    const wif = one("gcp:serviceaccount/iAMMember:IAMMember", "numu-know-release-observer-wif");
    expect(String(wif.inputs.member)).toMatch(/attribute\.release\/338675328$/);
  });

  it.each([
    ["a -dev project as prod", { releaseObservers: [{ product: "x", prodProject: "x-proj-dev", repo: { name: "a/b", id: "1", defaultBranch: "main" } }] }],
    ["a quote in the branch (CEL injection)", { releaseObservers: [{ product: "x", prodProject: "x-proj", repo: { name: "a/b", id: "1", defaultBranch: "main' || true || '" } }] }],
    ["duplicate products", { releaseObservers: [config.releaseObservers[0], config.releaseObservers[0]] }],
    ["a shared repo id", { releaseObservers: [config.releaseObservers[0], { ...config.releaseObservers[0], product: "other", prodProject: "other-proj" }] }],
    ["a shared prod project", { releaseObservers: [config.releaseObservers[0], { ...config.releaseObservers[0], product: "other", repo: { name: "a/b", id: "9", defaultBranch: "main" } }] }],
  ])("rejects config with %s", (_name, patch) => {
    expect(() => parseFactoryConfig({ ...config, ...patch })).toThrow();
  });
});
