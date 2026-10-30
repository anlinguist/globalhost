import { describe, expect, it } from "vitest";
import { ROLE_IDS, definitionHash, roleDefinition } from "../src/index.js";

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

  it("hashes stably and changes with the model", () => {
    const a = roleDefinition("builder");
    expect(definitionHash(a)).toBe(definitionHash(roleDefinition("builder")));
    expect(definitionHash(a)).not.toBe(definitionHash(roleDefinition("builder", "claude-sonnet-5-5")));
    expect(definitionHash(a)).not.toBe(definitionHash(roleDefinition("planner")));
  });
});
