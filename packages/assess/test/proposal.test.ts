import { cloudBuildTrigger } from "@globalhost/adapter-cloud-build-trigger";
import { createRegistry, type DeployAdapter, type Profile } from "@globalhost/core";
import { webApp } from "@globalhost/profile-web-app";
import { describe, expect, it } from "vitest";
import type { GcpFacts } from "../src/checks/gcp.js";
import { checkAgentFactoryYaml, partName, productSlug, proposeFactoryYaml, type ReleaseProposer } from "../src/proposal.js";
import { baseFacts } from "./helpers.js";

const profiles: Profile[] = [webApp as unknown as Profile];
const registry = createRegistry(profiles, [cloudBuildTrigger as unknown as DeployAdapter]);

const gcp: GcpFacts = {
  project: "numu-know",
  triggers: { ok: true, truncated: false, items: [{ id: "t1", name: "numu-know-main", disabled: false, repo: "anlinguist/numu-know", pushBranch: "^main$" }] },
  services: { ok: true, truncated: false, items: [{ name: "numu-know", region: "us-east1" }] },
  firestore: { ok: true, items: [], truncated: false },
};

const release: ReleaseProposer = ({ gcp: g }) =>
  g?.triggers.ok && g.triggers.items[0] ? { adapter: "cloud-build-trigger", config: { project: g.project, trigger: g.triggers.items[0].name } } : undefined;

describe("proposeFactoryYaml", () => {
  it("proposes a valid L1 factory.yaml for numu-know without GCP facts, noting what's missing", () => {
    const p = proposeFactoryYaml({ facts: baseFacts(), profiles, registry, proposeRelease: release });
    expect(p.errors).toEqual([]);
    expect(p.product).toBe("numu-know");
    expect(p.owners).toEqual([{ login: "anlinguist", id: 47403803 }]);
    expect(p.text).toContain("autonomy: L1");
    expect(p.text).toContain("gcpProject: numu-know-dev");
    expect(p.text).not.toContain("prod:");
    expect(p.notes.join("\n")).toMatch(/release is empty/);
    expect(p.notes.join("\n")).toMatch(/environments.prod is omitted/);
  });

  it("keeps the existing deploy and records prod when GCP was checked", () => {
    const p = proposeFactoryYaml({ facts: { ...baseFacts(), gcp }, profiles, registry, proposeRelease: release });
    expect(p.errors).toEqual([]);
    expect(p.text).toContain("adapter: cloud-build-trigger");
    expect(p.text).toContain("trigger: numu-know-main");
    expect(p.text).toMatch(/prod:\n\s+gcpProject: numu-know\n\s+region: us-east1/);
  });

  it("reports validation errors instead of hiding them", () => {
    const f = baseFacts();
    f.stack.proposed = [{ ...f.stack.proposed[0]!, suggestedConfig: { port: "not a port" } }];
    const p = proposeFactoryYaml({ facts: f, profiles, registry });
    expect(p.errors.join("\n")).toMatch(/parts\.web\.config\.port/);
  });

  it("asks for real owners when the repo belongs to an organization", () => {
    const f = baseFacts();
    f.github.owner = { login: "readefine-app", id: 99, type: "Organization" };
    expect(proposeFactoryYaml({ facts: f, profiles, registry }).notes[0]).toMatch(/organization readefine-app/);
    expect(proposeFactoryYaml({ facts: f, profiles, registry, owners: [{ login: "anlinguist", id: 47403803 }] }).owners).toEqual([{ login: "anlinguist", id: 47403803 }]);
  });
});

describe("names", () => {
  it.each([
    ["numu-know", "numu-know"],
    ["Numu_Know.v2", "numu-know-v2"],
    ["123-app", "app"],
    ["x", "appx"],
    ["a".repeat(40), "a".repeat(31)],
  ])("productSlug(%s) = %s", (repo, slug) => expect(productSlug(repo)).toBe(slug));

  it("names parts from their path or profile, uniquely", () => {
    expect(partName(".", "web-app", new Set())).toBe("web");
    expect(partName("apps/admin-ui", "web-app", new Set())).toBe("adminui");
    expect(partName("apps/web", "web-app", new Set(["web"]))).toBe("web2");
    expect(partName("apps/123", "web-app", new Set())).toBe("part");
  });
});

describe("checkAgentFactoryYaml (the assessor's own proposal)", () => {
  const proposal = proposeFactoryYaml({ facts: baseFacts(), profiles, registry });

  it("accepts a valid edit that keeps owners, product and autonomy", () => {
    const edited = proposal.text.replace("port: 8080", "port: 3000");
    expect(edited).not.toBe(proposal.text);
    expect(checkAgentFactoryYaml(edited, registry, proposal)).toEqual({ ok: true });
  });

  it("rejects a hostile edit that swaps the owner, raises autonomy or turns on auto-merge", () => {
    const hostile = proposal.text
      .replace("login: anlinguist", "login: mallory")
      .replace("id: 47403803", "id: 666")
      .replace("autonomy: L1", "autonomy: L3\nautoMerge: [lint-fix]");
    const r = checkAgentFactoryYaml(hostile, registry, proposal);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(["owners differ from the harness's proposal", "autonomy must be L1 for onboarding, not L3", "autoMerge must be empty for onboarding"]);
  });

  it("rejects YAML that doesn't validate", () => {
    const r = checkAgentFactoryYaml("version: 1\nowners: !!js/function 'x'\n", registry, proposal);
    expect(r.ok).toBe(false);
  });
});
