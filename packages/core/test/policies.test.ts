import { describe, expect, it } from "vitest";
import { IMMUTABLE_BASELINE } from "../src/index.js";
import { evaluatePathPolicy, globMatch, pathPolicyAllows } from "../src/path-policy.js";
import { gate, type GateEvent } from "../src/trust-gate.js";

describe("globMatch (FACTORY-YAML §3.6)", () => {
  it.each([
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", ".github", true],
    [".github/**", ".GitHub/workflows/x.yml", true],
    ["factory.yaml", "Factory.YAML", true],
    ["factory.yaml", "apps/factory.yaml", false],
    ["CODEOWNERS", "CODEOWNERS", true],
    ["app/api/**", "app/api/route.ts", true],
    ["app/api/**", "app/apix/route.ts", false],
    ["lib/firebase*", "lib/firebase.ts", true],
    ["lib/firebase*", "lib/firebase/admin.ts", false],
    ["*.ts", ".env.ts", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["**/secrets.json", "secrets.json", true],
    ["**/secrets.json", "a/b/c/secrets.json", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a.b", "axb", false],
    ["(x)+", "(x)+", true],
  ])("%s vs %s → %s", (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });

  it("stays fast on pathological ** patterns", () => {
    const pattern = Array.from({ length: 30 }, () => "**").join("/") + "/z";
    const path = Array.from({ length: 40 }, () => "a").join("/");
    const t = performance.now();
    expect(globMatch(pattern, path)).toBe(false);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("evaluatePathPolicy", () => {
  const policy = { immutable: [...IMMUTABLE_BASELINE], loadBearing: ["proxy.ts", "app/api/**"] };

  it("rejects the immutable baseline in any case and flags load-bearing paths", () => {
    const r = evaluatePathPolicy(
      [".github/workflows/globalhost.yml", ".GITHUB/x", "factory.yaml", "docs/CODEOWNERS", "proxy.ts", "app/api/a.ts", "src/ok.ts"],
      policy,
    );
    expect(r.rejected.map((x) => x.path)).toEqual([".github/workflows/globalhost.yml", ".GITHUB/x", "factory.yaml", "docs/CODEOWNERS"]);
    expect(r.needsApproval.map((x) => x.path)).toEqual(["proxy.ts", "app/api/a.ts"]);
    expect(pathPolicyAllows(r)).toBe(false);
  });

  it.each(["/etc/passwd", "../x", "a/../.github/x", "a\\b", "a//b", "a/", "", "x\u0000y", "./factory.yaml"])(
    "treats %j as malformed",
    (path) => {
      const r = evaluatePathPolicy([path], policy);
      expect(r.malformed).toEqual([path]);
      expect(pathPolicyAllows(r)).toBe(false);
    },
  );

  it("allows ordinary changes", () => {
    expect(pathPolicyAllows(evaluatePathPolicy(["src/a.ts", "README.md", ".githubx/a"], policy))).toBe(true);
  });
});

describe("trust gate", () => {
  const OWNERS = [47403803];
  const label = (over: Partial<Extract<GateEvent, { kind: "label" }>> = {}): GateEvent => ({
    kind: "label",
    label: "factory:build",
    senderId: 47403803,
    issue: 12,
    isPullRequest: false,
    ...over,
  });
  const comment = (over: Partial<Extract<GateEvent, { kind: "comment" }>> = {}): GateEvent => ({
    kind: "comment",
    senderId: 47403803,
    senderType: "User",
    pullRequest: { number: 30, headRef: "factory/issue-12", headRepoIsBase: true },
    body: "Use the existing Button component.",
    ...over,
  });

  it("starts the planner and builder on owner labels", () => {
    expect(gate(label({ label: "factory:plan" }), OWNERS)).toEqual({ action: "start", role: "planner", issue: 12 });
    expect(gate(label(), OWNERS)).toEqual({ action: "start", role: "builder", issue: 12 });
  });

  it.each([
    ["a non-owner's label", label({ senderId: 1 })],
    ["an unknown factory label", label({ label: "factory:deploy" })],
    ["a prototype-named label", label({ label: "__proto__" })],
    ["a label on a PR", label({ isPullRequest: true })],
    ["a comment on an issue", comment({ pullRequest: undefined })],
    ["a comment on an unplanned issue", comment({ pullRequest: undefined, issue: { number: 12, labels: ["bug", "factory:plan"] } })],
    ["a non-owner's reply to a plan", comment({ senderId: 1, pullRequest: undefined, issue: { number: 12, labels: ["factory:planned"] } })],
    ["a bot reply to a plan", comment({ senderType: "Bot", pullRequest: undefined, issue: { number: 12, labels: ["factory:planned"] } })],
    ["a quoted reply to a plan", comment({ body: "> the plan says\nok", pullRequest: undefined, issue: { number: 12, labels: ["factory:planned"] } })],
    ["a lookalike label", comment({ pullRequest: undefined, issue: { number: 12, labels: ["factory:planned-ish", "Factory:Planned"] } })],
    ["a non-owner's comment", comment({ senderId: 1 })],
    ["a bot comment with an owner's id", comment({ senderType: "Bot" })],
    ["a comment on a non-factory PR", comment({ pullRequest: { number: 30, headRef: "feature/x", headRepoIsBase: true } })],
    ["a comment on a fork's factory branch", comment({ pullRequest: { number: 30, headRef: "factory/issue-12", headRepoIsBase: false } })],
    ["a lookalike branch", comment({ pullRequest: { number: 30, headRef: "factory/issue-12x", headRepoIsBase: true } })],
    ["a quoted comment", comment({ body: "> earlier text\nthanks" })],
    ["a [no-factory] comment", comment({ body: "Looks good [No-Factory]" })],
    ["an empty comment", comment({ body: "   " })],
  ])("ignores %s", (_name, event) => {
    expect(gate(event, OWNERS).action).toBe("ignore");
  });

  it.each(["factory:planned", "factory:blocked"])("resumes the planner on an owner's reply to an issue labeled %s", (l) => {
    expect(gate(comment({ pullRequest: undefined, issue: { number: 12, labels: ["bug", l] }, body: "Skip the refactor." }), OWNERS)).toEqual({
      action: "resume",
      role: "planner",
      issue: 12,
      feedback: "Skip the refactor.",
    });
  });

  it("resumes the builder on an owner's PR comment", () => {
    expect(gate(comment(), OWNERS)).toEqual({
      action: "resume",
      role: "builder",
      issue: 12,
      pullRequest: 30,
      feedback: "Use the existing Button component.",
    });
  });
});
