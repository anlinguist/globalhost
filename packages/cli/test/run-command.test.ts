import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, type RunIo } from "../src/run-command.js";

function io(env: NodeJS.ProcessEnv = {}): RunIo & { stdout: string; stderr: string } {
  const r = {
    stdout: "",
    stderr: "",
    env,
    cwd: "/tmp",
    out: (t: string) => void (r.stdout += t),
    err: (t: string) => void (r.stderr += t),
  };
  return r;
}

describe("globalhost run (argument handling)", () => {
  it("prints usage on --help", async () => {
    const r = io();
    expect(await runCommand(["run", "--help"], r)).toBe(0);
    expect(r.stdout).toContain("globalhost run <owner/repo> <issue>");
  });

  it("requires the local service account before doing anything", async () => {
    const r = io();
    expect(await runCommand(["run", "anlinguist/numu-know", "10", "--role", "planner"], r)).toBe(2);
    expect(r.stderr).toContain("GLOBALHOST_LOCAL_SA is not set");
  });

  const env = {
    GLOBALHOST_LOCAL_SA: "globalhost-local@globalhost-factory.iam.gserviceaccount.com",
    ANTHROPIC_ORGANIZATION_ID: "o",
    ANTHROPIC_FEDERATION_RULE_ID: "r",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "s",
    ANTHROPIC_WORKSPACE_ID: "w",
  };

  it.each([
    [["run", "anlinguist/numu-know", "10", "--role", "deployer"], "--role must be one of"],
    [["run", "anlinguist/numu-know", "10", "--role", "assessor"], "--role must be one of planner, builder"],
    [["run", "anlinguist/numu-know", "0", "--role", "planner"], "issue must be a positive integer"],
    [["run", "../etc", "1", "--role", "planner"], "not an owner/name repo slug"],
    [["run", "anlinguist/numu-know", "1", "--role", "planner", "--budget", "400"], "--budget must be a number"],
    [["run", "--resume", "sesn_abc"], "--resume needs --feedback"],
    [["run", "--resume", "x;rm -rf", "--feedback", "hi"], "--resume needs a session ID"],
    [["run", "--bogus"], "Unknown option"],
  ])("rejects %j with exit 2", async (argv, message) => {
    const r = io(env);
    const code = await runCommand(argv, r);
    expect(r.stderr).toContain(message);
    expect(code).toBe(2);
  });

  it("escapes control characters in errors", async () => {
    const r = io(env);
    await runCommand(["run", "--resume", "sesn_\u001b[2J", "--feedback", "x"], r);
    expect(r.stderr.includes("\u001b")).toBe(false);
  });
});

describe("globalhost roles sync", () => {
  it("uploads the registered profiles' skills once and pins them on every role's agent", async () => {
    const skills: { displayName: string; files: string[] }[] = [];
    const agents: { name: string; skills: unknown }[] = [];
    const api = {
      findSkill: async (name: string) => (skills.some((s) => s.displayName === name) ? { id: "skill_1", latestVersion: "v1" } : undefined),
      createSkill: async (displayName: string, files: readonly { path: string }[]) => {
        skills.push({ displayName, files: files.map((f) => f.path) });
        return { id: "skill_1", latestVersion: "v1" };
      },
      findAgent: async () => undefined,
      createAgent: async (def: { agentName: string; skills: unknown }) => {
        agents.push({ name: def.agentName, skills: def.skills });
        return { id: `agent_${agents.length}`, version: 1, name: def.agentName, metadata: {} };
      },
    } as unknown as RunIo["api"];
    const r = Object.assign(io(), { api });
    expect(await runCommand(["roles", "sync"], r)).toBe(0);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.displayName).toMatch(/^globalhost-web-app [0-9a-f]{12}$/);
    expect(skills[0]!.files).toContain("web-app/SKILL.md");
    expect(agents.map((a) => a.name)).toEqual(["globalhost-planner", "globalhost-builder", "globalhost-assessor"]);
    for (const a of agents) expect(a.skills).toEqual([{ skillId: "skill_1", version: "v1" }]);
  });
});

describe("globalhost run --config", () => {
  it("rejects an invalid factory.yaml before starting anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(dir, "factory.yaml"), "version: 1\nowners: [{ login: anlinguist }]\n");
    const r = Object.assign(io(), { api: {} as RunIo["api"], cwd: dir });
    expect(await runCommand(["run", "anlinguist/numu-know", "10", "--role", "planner", "--config", "factory.yaml"], r)).toBe(2);
    expect(r.stderr).toContain("factory.yaml:");
  });
});
