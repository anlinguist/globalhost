import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAgent } from "../src/managed-agents.js";
import { ensureSkill, readSkillDir, skillDisplayName } from "../src/skills.js";
import { definitionHash, roleDefinition } from "@globalhost/roles";
import { FakeApi } from "./fake-api.js";

function skillDir(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "skill-")), "web-app");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("skills", () => {
  it("reads every file under one top-level directory, in a stable order", () => {
    const dir = skillDir({ "SKILL.md": "# skill", "refs/b.md": "b", "refs/a.md": "a" });
    expect(readSkillDir(dir).map((f) => f.path)).toEqual(["web-app/SKILL.md", "web-app/refs/a.md", "web-app/refs/b.md"]);
  });

  it("refuses a directory without SKILL.md, or with a symlink", () => {
    expect(() => readSkillDir(skillDir({ "README.md": "x" }))).toThrow(/no SKILL.md/);
    const dir = skillDir({ "SKILL.md": "# skill" });
    symlinkSync("/etc/passwd", join(dir, "leak"));
    expect(() => readSkillDir(dir)).toThrow(/not a regular file/);
  });

  it("names a skill by its content, so only an edit uploads a new one", async () => {
    const api = new FakeApi();
    const a = await ensureSkill(api, skillDir({ "SKILL.md": "v1" }));
    const again = await ensureSkill(api, skillDir({ "SKILL.md": "v1" }));
    const edited = await ensureSkill(api, skillDir({ "SKILL.md": "v2" }));
    expect(again).toEqual(a);
    expect(edited.skillId).not.toBe(a.skillId);
    expect(api.skills.map((s) => s.displayName)).toEqual([
      skillDisplayName(readSkillDir(skillDir({ "SKILL.md": "v1" }))),
      skillDisplayName(readSkillDir(skillDir({ "SKILL.md": "v2" }))),
    ]);
    expect(api.skills[0]!.displayName).toMatch(/^globalhost-web-app [0-9a-f]{12}$/);
  });

  it("pins skills on the agent and updates it when a skill changes", async () => {
    const api = new FakeApi();
    const pin1 = await ensureSkill(api, skillDir({ "SKILL.md": "v1" }));
    const def1 = roleDefinition("builder", undefined, [pin1]);
    const first = await ensureAgent(api, def1, definitionHash(def1));
    expect(api.agentSkills.get(first.id)).toEqual([pin1]);

    const pin2 = await ensureSkill(api, skillDir({ "SKILL.md": "v2" }));
    const def2 = roleDefinition("builder", undefined, [pin2]);
    const second = await ensureAgent(api, def2, definitionHash(def2));
    expect(second).toEqual({ id: first.id, version: 2 });
    expect(api.agentSkills.get(first.id)).toEqual([pin2]);
  });
});
