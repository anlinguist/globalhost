import { describe, expect, it } from "vitest";
import { AssessorReadinessSchema, RUBRIC, combineReadiness, factScores } from "../src/readiness.js";
import { baseFacts, fixture } from "./helpers.js";
import type { GcpFacts } from "../src/checks/gcp.js";

const gcp = (pr: boolean): GcpFacts => ({
  project: "numu-know",
  triggers: { ok: true, truncated: false, items: [{ id: "t", name: "t", disabled: false, ...(pr ? { pullRequestBranch: ".*" } : { pushBranch: "^main$" }) }] },
  services: { ok: true, items: [], truncated: false },
  firestore: { ok: true, items: [], truncated: false },
});

describe("the rubric", () => {
  it("adds up to 100, as ONBOARDING §1 defines it", () => {
    expect(RUBRIC.reduce((n, r) => n + r.max, 0)).toBe(100);
  });
});

describe("factScores", () => {
  it("scores numu-know-shaped facts: no CI, clean secrets, no agent docs, no tests", () => {
    const f = { ...baseFacts(), gcp: gcp(false) };
    expect(factScores(f)).toEqual({
      ci: { points: 0, evidence: expect.any(String) },
      secrets: { points: 10, evidence: expect.any(String) },
      testsExist: { points: 0, evidence: expect.any(String) },
    });
  });

  it("leaves CI to the assessor when GCP wasn't checked and there are no workflows", () => {
    expect(factScores(baseFacts()).ci).toBeUndefined();
  });

  it("gives CI points for an active workflow or a pull-request trigger", () => {
    const withWorkflow = baseFacts();
    withWorkflow.github.workflows = { ok: true, truncated: false, items: [{ name: "CI", path: ".github/workflows/ci.yml", state: "active" }] };
    expect(factScores(withWorkflow).ci?.points).toBe(5);
    expect(factScores({ ...baseFacts(), gcp: gcp(true) }).ci?.points).toBe(5);
  });

  it("zeroes secrets on any finding and defers when gitleaks didn't run or only names look suspicious", () => {
    const found = baseFacts();
    found.secrets.gitleaks = { status: "ran", version: "8", findings: [{ file: "a", rule: "r", commit: "c" }], truncated: false };
    expect(factScores(found).secrets?.points).toBe(0);
    const notRun = baseFacts();
    notRun.secrets.gitleaks = { status: "not-run", reason: "gitleaks is not installed" };
    expect(factScores(notRun).secrets).toBeUndefined();
    const named = baseFacts();
    named.secrets.credentialFiles = [{ path: ".env", kind: "env file", tracked: true, addedIn: "c" }];
    expect(factScores(named).secrets).toBeUndefined();
  });

  it("gives docs points for CLAUDE.md and defers on tests that exist", () => {
    const f = baseFacts();
    f.docs.agentDocs = ["CLAUDE.md"];
    f.tests = { count: 3, sample: ["a.test.ts"] };
    expect(factScores(f).docs?.points).toBe(5);
    expect(factScores(f).testsExist).toBeUndefined();
  });
});

describe("combineReadiness", () => {
  it("lets facts win, clamps the assessor to each item's maximum, and counts unscored items as 0", () => {
    const assessor = AssessorReadinessSchema.parse([
      { id: "secrets", points: 0, evidence: "trying to override a fact" },
      { id: "ci", points: 15, evidence: "over the 5-point maximum" },
      { id: "build", points: 15, evidence: "builds" },
    ]);
    const r = combineReadiness({ secrets: { points: 10, evidence: "clean" } }, assessor);
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId.secrets).toMatchObject({ points: 10, source: "facts" });
    expect(byId.ci).toMatchObject({ points: 5, source: "assessor" });
    expect(byId.build).toMatchObject({ points: 15, source: "assessor" });
    expect(byId.nonProd).toMatchObject({ points: null, source: "unscored" });
    expect(r.total).toBe(30);
  });

  it("rejects malformed assessor scores outright", () => {
    expect(AssessorReadinessSchema.safeParse([{ id: "bribe", points: 100, evidence: "" }]).success).toBe(false);
    expect(AssessorReadinessSchema.safeParse([{ id: "build", points: -5, evidence: "" }]).success).toBe(false);
    expect(AssessorReadinessSchema.safeParse([{ id: "build", points: 1.5, evidence: "" }]).success).toBe(false);
  });

  it("keeps the gitleaks fixture's finding out of the score evidence", () => {
    const f = baseFacts();
    const [first] = fixture<{ File: string; RuleID: string; Commit: string }[]>("gitleaks-redacted.json");
    f.secrets.gitleaks = { status: "ran", version: "8", findings: [{ file: first!.File, rule: first!.RuleID, commit: first!.Commit }], truncated: false };
    expect(factScores(f).secrets?.evidence).not.toContain("config.js");
  });
});
