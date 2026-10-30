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
