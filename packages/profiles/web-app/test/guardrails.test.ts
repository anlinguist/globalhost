import { evaluateGuardrails, type ApprovalEvidence } from "@globalhost/core";
import { describe, expect, it } from "vitest";
import { visualBaseline, webApp } from "../src/index.js";

const HEAD = "a".repeat(40);
const noApproval: ApprovalEvidence = { headSha: HEAD, lastPushAt: "2026-11-04T10:00:00Z", ownerIds: [1001], appActorIds: [], currentLabels: [], events: [], eventsComplete: true };
const approvedVisual: ApprovalEvidence = {
  ...noApproval,
  currentLabels: ["approved:visual"],
  events: [{ action: "labeled", label: "approved:visual", actor: { id: 1001, type: "User" }, at: "2026-11-04T11:00:00Z", headSha: HEAD }],
};

/** The web-app profile's own checks through the real engine, as slice 2's caller will run them. */
const run = (paths: string[], approval = noApproval, trees: { base?: Record<string, string>; head?: Record<string, string> } = {}) =>
  evaluateGuardrails({
    files: paths.map((path) => ({ path, modes: ["100644", "100644"] })),
    filesComplete: true,
    config: { loadBearing: [], immutable: [] },
    guardrails: webApp.guardrails.checks,
    releaseSets: [{ part: "web", adapter: "deployer", set: { globs: ["deploy.conf"] } }],
    unknownProfiles: [],
    diff: { readBase: (p) => Promise.resolve(trees.base?.[p]), readHead: (p) => Promise.resolve(trees.head?.[p]) },
    approval,
  });

const visualVerdict = async (path: string) => (await run([path])).entries.find((e) => e.id === "visual-baseline")?.verdict;

describe("visual-baseline", () => {
  it("is approved with approved:visual", () => {
    expect(visualBaseline.approvalLabel).toBe("approved:visual");
  });

  it.each([
    "e2e/home.spec.ts-snapshots/home-chromium-darwin.png",
    "tests/visual/a.spec.ts-snapshots/deep/er.png",
    "src/__screenshots__/button.test.tsx/primary-1.png",
    "src/__image_snapshots__/button-test-tsx-primary-1-snap.png",
    "cypress/snapshots/home.cy.ts/home.png",
    "apps/web/cypress/snapshots/x.png",
    "E2E/HOME.SPEC.TS-SNAPSHOTS/X.PNG",
  ])("trips on %s", async (path) => {
    expect(await visualVerdict(path)).toBe("needsApproval");
  });

  it.each(["e2e/home.spec.ts", "public/logo.png", "src/__snapshots__/x.test.ts.snap", "docs/snapshots/x.png", "src/screenshots/x.png"])("doesn't trip on %s", async (path) => {
    expect(await visualVerdict(path)).toBe("pass");
  });

  it("trips when a baseline is renamed away", async () => {
    const report = await evaluateGuardrails({
      files: [{ path: "src/old.png", previousPath: "e2e/a.spec.ts-snapshots/old.png", modes: ["100644", "100644"] }],
      filesComplete: true,
      config: { loadBearing: [], immutable: [] },
      guardrails: [visualBaseline],
      releaseSets: [],
      unknownProfiles: [],
      diff: { readBase: () => Promise.resolve(undefined), readHead: () => Promise.resolve(undefined) },
      approval: noApproval,
    });
    expect(report.verdict).toBe("needsApproval");
  });

  it("is cleared by its own label on this head", async () => {
    const report = await run(["e2e/a.spec.ts-snapshots/a.png"], approvedVisual);
    expect(report.verdict).toBe("pass");
    expect(report.entries.find((e) => e.id === "visual-baseline")?.approval).toEqual({ cleared: true, code: "cleared" });
  });
});

describe("dependency-change in the web-app profile", () => {
  it("runs through the engine: a changed lockfile needs approved:deps, and approved:visual doesn't clear it", async () => {
    const trees = { base: { "package-lock.json": '{"packages":{"node_modules/a":{"version":"1.0.0"}}}' }, head: { "package-lock.json": '{"packages":{"node_modules/a":{"version":"1.0.1"}}}' } };
    const report = await run(["package-lock.json"], approvedVisual, trees);
    expect(report.verdict).toBe("needsApproval");
    expect(report.entries.find((e) => e.id === "dependency-change")).toMatchObject({
      verdict: "needsApproval",
      approvalLabel: "approved:deps",
      paths: ["package-lock.json"],
      subjects: ["a"],
      approval: { cleared: false, code: "label-absent" },
    });
  });
});
