import { describe, expect, it } from "vitest";
import { gcpFacts, keyStatuses } from "../src/checks/gcp.js";
import { fakeExec, fixture } from "./helpers.js";

const json = (name: string) => ({ stdout: JSON.stringify(fixture(`gcloud/${name}.json`)) });

function gcloud(overrides: Record<string, ReturnType<typeof json> | { error: { code?: string | number; stderr?: string } }> = {}) {
  return fakeExec(({ file, args }) => {
    expect(file).toBe("gcloud");
    // Read-only list calls only, always as JSON and never interactive.
    expect(args).toContain("list");
    expect(args.slice(-2)).toEqual(["--format=json", "--quiet"]);
    const key = args.slice(0, 2).join(" ");
    if (key in overrides) return overrides[key];
    if (key === "builds triggers") return json("triggers");
    if (key === "run services") return json("services");
    if (key === "firestore databases") return json("firestore");
    if (key === "iam service-accounts") return json("keys");
    return undefined;
  });
}

describe("gcpFacts", () => {
  it("lists triggers, services and databases, keeping names, branches and URLs only", async () => {
    const { exec, calls } = gcloud();
    const f = await gcpFacts("numu-know", exec);
    expect(calls.map((c) => c.args.slice(0, 5).join(" "))).toEqual([
      "builds triggers list --project numu-know",
      "run services list --project numu-know",
      "firestore databases list --project numu-know",
    ]);
    expect(f.triggers).toEqual({
      ok: true,
      truncated: false,
      items: [
        { id: "0f0e0d0c-0000-4000-8000-000000000001", name: "numu-know-main", disabled: false, repo: "anlinguist/numu-know", pushBranch: "^main$", pullRequestBranch: undefined, filename: "cloudbuild.yaml" },
        { id: "0f0e0d0c-0000-4000-8000-000000000002", name: "staging-numu-know", disabled: false, repo: "anlinguist/numu-know", pushBranch: "^staging$", pullRequestBranch: undefined, filename: "cloudbuild.yaml" },
        { id: "0f0e0d0c-0000-4000-8000-000000000003", name: "old-pr-check", disabled: true, repo: "anlinguist/numu-know", pushBranch: undefined, pullRequestBranch: ".*", filename: undefined },
      ],
    });
    expect(f.services).toEqual({
      ok: true,
      truncated: false,
      items: [{ name: "numu-know", region: "us-central1", url: "https://numu-know-abc123-uc.a.run.app", image: "us-central1-docker.pkg.dev/numu-know/cloud-run-source-deploy/numu-know:latest" }],
    });
    expect(f.firestore).toEqual({ ok: true, truncated: false, items: [{ name: "(default)", type: "FIRESTORE_NATIVE", location: "nam5" }] });
    // Substitutions and env values (which can hold secrets) are dropped at parse time.
    const text = JSON.stringify(f);
    expect(text).not.toContain("MUST-NOT-BE-KEPT");
    expect(text).not.toContain("KLAVIYO_KEY");
  });

  it("reports each failure on its own line without failing the rest", async () => {
    const { exec } = gcloud({
      "builds triggers": { error: { code: 1, stderr: "\nERROR: (gcloud.builds.triggers.list) PERMISSION_DENIED: The caller does not have permission\nmore" } },
      "run services": { stdout: "not json" },
    });
    const f = await gcpFacts("numu-know", exec);
    expect(f.triggers).toEqual({ ok: false, reason: "gcloud failed: ERROR: (gcloud.builds.triggers.list) PERMISSION_DENIED: The caller does not have permission" });
    expect(f.services).toEqual({ ok: false, reason: "unexpected output from gcloud run services list" });
    expect(f.firestore.ok).toBe(true);
  });

  it("says so when gcloud isn't installed", async () => {
    const { exec } = fakeExec(() => undefined);
    const f = await gcpFacts("numu-know", exec);
    expect(f.triggers).toEqual({ ok: false, reason: "gcloud is not installed" });
  });

  it("rejects a project id that could be an argument", async () => {
    const { exec } = gcloud();
    await expect(gcpFacts("--impersonate-service-account=x", exec)).rejects.toThrow("not a GCP project id");
  });
});

describe("keyStatuses", () => {
  const ref = (keyId: string) => ({ path: "sa.json", commit: "c".repeat(40), clientEmail: "deployer@demo-proj.iam.gserviceaccount.com", keyId });

  it("marks a listed, enabled key active and a disabled or missing one inactive, without echoing key ids", async () => {
    const { exec, calls } = gcloud();
    const out = await keyStatuses([ref("0123456789abcdef0123456789abcdef01234567"), ref("fedcba9876543210fedcba9876543210fedcba98"), ref("1".repeat(40))], exec);
    expect(out.map((k) => k.active)).toEqual([true, false, false]);
    expect(calls[0]!.args).toEqual(["iam", "service-accounts", "keys", "list", "--iam-account", "deployer@demo-proj.iam.gserviceaccount.com", "--format=json", "--quiet"]);
    expect(JSON.stringify(out)).not.toContain("0123456789abcdef");
  });

  it("leaves activity unknown when IAM can't be asked", async () => {
    const { exec } = gcloud({ "iam service-accounts": { error: { code: 1, stderr: "ERROR: NOT_FOUND: Unknown service account" } } });
    const [k] = await keyStatuses([ref("a".repeat(40))], exec);
    expect(k).not.toHaveProperty("active");
    expect(k!.reason).toBe("gcloud failed: ERROR: NOT_FOUND: Unknown service account");
  });
});
