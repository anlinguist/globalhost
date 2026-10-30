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

interface Registered {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const PROJECT = "globalhost-factory";
const PROJECT_NUMBER = "123456789012";
const resources: Registered[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push({ type: args.type, name: args.name, inputs: args.inputs as Record<string, unknown> });
      const state: Record<string, unknown> = { ...args.inputs };
      switch (args.type) {
        case "gcp:serviceaccount/account:Account": {
          const email = `${String(args.inputs.accountId)}@${PROJECT}.iam.gserviceaccount.com`;
          state.email = email;
          state.name = `projects/${PROJECT}/serviceAccounts/${email}`;
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
      }
      return { id: `${args.name}-id`, state };
    },
    call(args) {
      if (args.token === "gcp:organizations/getProject:getProject") {
        return { number: PROJECT_NUMBER, projectId: PROJECT };
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
  });
  // Resolve every output so all resources (and their inputs) have registered.
  await new Promise<void>((resolve) =>
    pulumi.all(Object.values(outputs)).apply(() => {
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
    expect(ofType("gcp:secretmanager/secretVersion:SecretVersion")).toEqual([]);

    const policies = ofType("gcp:secretmanager/secretIamPolicy:SecretIamPolicy");
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
    expect(budget.inputs.budgetFilter).toMatchObject({ projects: [`projects/${PROJECT_NUMBER}`] });
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
    const secrets = ofType("gcp:secretmanager/secret:Secret").map((r) => r.inputs.secretId);
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
