import { describe, expect, it } from "vitest";
import { ISSUE_ROLE_IDS, ROLE_IDS, definitionHash, roleDefinition } from "../src/index.js";

describe("role definitions", () => {
  it.each(ROLE_IDS)("%s has a system prompt with the shared trust rules and no web tools", (id) => {
    const def = roleDefinition(id);
    expect(def.system).toContain("<untrusted");
    expect(def.system).toContain("report.json");
    expect(def.toolConfigs).toEqual(
      expect.arrayContaining([
        { name: "web_fetch", enabled: false },
        { name: "web_search", enabled: false },
      ]),
    );
    expect(def.requiredOutputs).toContain("report.json");
  });

  it("forbids editing the immutable paths in every role", () => {
    for (const id of ROLE_IDS) expect(roleDefinition(id).system).toContain("`.github/**`");
  });

  it("gives the planner no edit tool", () => {
    expect(roleDefinition("planner").toolConfigs).toContainEqual({ name: "edit", enabled: false });
  });

  it("gives the assessor no edit tool, no bundle, and the rubric to score", () => {
    const def = roleDefinition("assessor");
    expect(def.toolConfigs).toContainEqual({ name: "edit", enabled: false });
    expect(def.requiredOutputs).toEqual(["assessment.md", "report.json"]);
    expect(def.requiredOutputs).not.toContain("result.bundle");
    for (const id of ["build", "typecheckLint", "testsExist", "testsCritical", "localDev", "nonProd", "docs", "secrets", "ci"]) {
      expect(def.system).toContain(`\`${id}\``);
    }
    expect(ISSUE_ROLE_IDS).not.toContain("assessor");
  });

  it("hashes stably and changes with the model", () => {
    const a = roleDefinition("builder");
    expect(definitionHash(a)).toBe(definitionHash(roleDefinition("builder")));
    expect(definitionHash(a)).not.toBe(definitionHash(roleDefinition("builder", "claude-sonnet-5-5")));
    expect(definitionHash(a)).not.toBe(definitionHash(roleDefinition("planner")));
    const pinned = roleDefinition("builder", undefined, [{ skillId: "skill_1", version: "1" }]);
    expect(definitionHash(a)).not.toBe(definitionHash(pinned));
    expect(definitionHash(pinned)).not.toBe(definitionHash(roleDefinition("builder", undefined, [{ skillId: "skill_1", version: "2" }])));
  });
});
