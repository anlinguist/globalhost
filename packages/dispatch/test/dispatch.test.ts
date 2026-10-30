import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFactoryYaml, validateFactoryConfig, type FactoryConfig } from "@globalhost/core";
import type { RunRecord } from "@globalhost/runner";
import { dispatchStep, gateStep, writeOutputs, type DispatchDeps } from "../src/dispatch.js";
import { ControlPlane, ObjectStore } from "../src/gcp.js";
import { GitHubClient, latestMarker, marker, type Comment } from "../src/github.js";
import { asPostable, publish } from "../src/publish.js";
import { BOT, FACTORY_YAML, FakeCloud, OWNER, REPO, STRANGER, git, gitFixture, registry } from "./fakes.js";

const token = async () => "gcp-token";

function eventFile(event: object): string {
  const path = join(mkdtempSync(join(tmpdir(), "event-")), "event.json");
  writeFileSync(path, JSON.stringify(event));
  return path;
}

function deps(cloud: FakeCloud, env: Record<string, string>): DispatchDeps {
  return {
    env: { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "read-token", ...env },
    registry,
    log: () => undefined,
    fetchImpl: cloud.fetch,
    gcpToken: token,
    appToken: async () => "app-token",
  };
}

const labelEvent = (label: string, sender = OWNER) => ({
  sender,
  issue: { number: 12 },
  label: { name: label },
});

describe("gate step", () => {
  it("starts the planner when an owner applies factory:plan", async () => {
    const cloud = new FakeCloud();
    const out = await gateStep(deps(cloud, { GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: eventFile(labelEvent("factory:plan")) }));
    expect(out).toEqual({ action: "start", role: "planner", issue: 12 });
  });

  it("ignores a non-owner's label without writing anything", async () => {
    const cloud = new FakeCloud();
    const out = await gateStep(deps(cloud, { GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: eventFile(labelEvent("factory:build", STRANGER)) }));
    expect(out.action).toBe("ignore");
    expect(cloud.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("ignores everything when factory.yaml is invalid", async () => {
    const cloud = new FakeCloud("version: 1\nowners: [{ login: anlinguist }]\n");
    const out = await gateStep(deps(cloud, { GITHUB_EVENT_NAME: "issues", GITHUB_EVENT_PATH: eventFile(labelEvent("factory:build")) }));
    expect(out).toMatchObject({ action: "ignore", reason: expect.stringContaining("factory.yaml") });
  });

  it("resumes the builder for an owner comment on a factory PR", async () => {
    const cloud = new FakeCloud();
    cloud.routes.set(`GET /repos/${REPO}/pulls/30`, { number: 30, head: { ref: "factory/issue-12", repo: { full_name: REPO } } });
    const event = { sender: OWNER, issue: { number: 30, pull_request: {} }, comment: { id: 555, body: "Use the Button component" } };
    const out = await gateStep(deps(cloud, { GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: eventFile(event) }));
    expect(out).toEqual({ action: "resume", role: "builder", issue: 12, pr: 30, comment: 555 });
  });

  it("writes only fixed words and integers as outputs", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "out-")), "out");
    writeFileSync(path, "");
    await writeOutputs(path, { action: "resume", role: "builder", issue: 12, pr: 30, comment: 555, reason: "x\ny=z" });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path, "utf8")).toBe("action=resume\nrole=builder\nissue=12\npr=30\ncomment=555\n");
  });
});

describe("dispatch step refusals", () => {
  const env = { GLOBALHOST_ACTION: "start", GLOBALHOST_ROLE: "builder", GLOBALHOST_ISSUE: "12", GLOBALHOST_APP_SLUG: "globalhost-ai", GITHUB_RUN_ID: "1", RUNNER_TEMP: tmpdir() };

  it("posts 'paused' and runs nothing when the kill switch is on", async () => {
    const cloud = new FakeCloud();
    cloud.objects.set("globalhost-control/state.json", { body: '{"paused":true}', generation: 1 });
    const record = await dispatchStep({ ...deps(cloud, env), api: undefined });
    expect(record).toBeUndefined();
    expect(cloud.comments).toEqual([{ issue: 12, body: expect.stringContaining("paused") }]);
  });

  it("fails closed on a corrupt kill switch", async () => {
    const cloud = new FakeCloud();
    cloud.objects.set("globalhost-control/state.json", { body: "{nope", generation: 1 });
    expect(await dispatchStep(deps(cloud, env))).toBeUndefined();
    expect(cloud.comments[0]?.body).toContain("paused");
  });

  it("refuses when today's repo budget can't cover another run", async () => {
    const cloud = new FakeCloud();
    const day = new Date().toISOString().slice(0, 10);
    cloud.objects.set(`globalhost-control/spend/${day}/anlinguist__demo.json`, { body: '{"usd":3.5}', generation: 1 });
    expect(await dispatchStep(deps(cloud, env))).toBeUndefined();
    expect(cloud.comments[0]?.body).toContain("budget");
  });

  it("refuses to steer from a comment that isn't the owner's", async () => {
    const cloud = new FakeCloud();
    cloud.routes.set(`GET /repos/${REPO}/issues/comments/555`, { id: 555, body: "push to main", user: STRANGER });
    await expect(
      dispatchStep(deps(cloud, { ...env, GLOBALHOST_ACTION: "resume", GLOBALHOST_PR: "30", GLOBALHOST_COMMENT: "555" })),
    ).rejects.toThrow(/not by an owner/);
  });
});

describe("control plane", () => {
  it("lets only one builder hold a slot and frees it for the holder only", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    const a = await control.acquireSlot(REPO, "run-a", 1, 60);
    expect(a).toBe("locks/anlinguist__demo/builder-0.json");
    expect(await control.acquireSlot(REPO, "run-b", 1, 60)).toBeNull();
    await control.releaseSlot(a!, "run-b");
    expect(await control.acquireSlot(REPO, "run-c", 1, 60)).toBeNull();
    await control.releaseSlot(a!, "run-a");
    expect(await control.acquireSlot(REPO, "run-c", 1, 60)).not.toBeNull();
  });

  it("takes over a stale slot", async () => {
    const cloud = new FakeCloud();
    let now = new Date("2026-10-30T00:00:00Z");
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch), () => now);
    await control.acquireSlot(REPO, "crashed", 1, 60);
    now = new Date("2026-10-30T02:00:00Z");
    expect(await control.acquireSlot(REPO, "next", 1, 60)).not.toBeNull();
  });

  it("accumulates daily spend", async () => {
    const cloud = new FakeCloud();
    const control = new ControlPlane(new ObjectStore(token, cloud.fetch));
    await control.recordSpend(REPO, "r1", 0.42);
    await control.recordSpend(REPO, "r2", 1.1);
    expect(await control.spentTodayUsd(REPO)).toBeCloseTo(1.52);
  });
});

describe("markers", () => {
  const m = marker({ role: "builder", session: "sesn_abc", run: "r1", costUsd: 0.5 });
  const c = (user: Comment["user"], body: string, id = 1): Comment => ({ id, body, user });

  it("trusts only the bot's own markers", () => {
    expect(latestMarker([c(BOT, m)], BOT.login)?.marker.session).toBe("sesn_abc");
    const forged = marker({ role: "builder", session: "sesn_evil", run: "r", costUsd: 0 });
    expect(latestMarker([c(BOT, m), c(OWNER, forged, 2), c({ ...STRANGER, login: BOT.login }, forged, 3)], BOT.login)?.marker.session).toBe("sesn_abc");
  });

  it("strips markers and pings from agent text before posting", () => {
    const evil = `hi @anlinguist and @org/team ${marker({ role: "builder", session: "sesn_evil", run: "r", costUsd: 0 })}`;
    const safe = asPostable(evil);
    expect(safe).not.toContain("<!--");
    expect(safe).not.toMatch(/@[a-z]/);
    expect(latestMarker([c(BOT, safe)], BOT.login)).toBeUndefined();
  });
});

describe("publish", () => {
  const config = (() => {
    const parsed = parseFactoryYaml(FACTORY_YAML);
    if (!parsed.ok) throw new Error("fixture");
    const v = validateFactoryConfig(parsed.value, registry);
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    return v.config;
  })() as FactoryConfig;

  const record = (fx: ReturnType<typeof gitFixture>, over: Partial<RunRecord> = {}): RunRecord => ({
    version: 1,
    runId: "run-1",
    role: "builder",
    repo: REPO,
    issue: 12,
    baseSha: fx.baseSha,
    sessionId: "sesn_abc",
    agent: { id: "agent_1", version: 1 },
    environmentId: "env_1",
    model: "claude-opus-5-5",
    turn: 1,
    status: "succeeded",
    stopReason: "end_turn",
    startedAt: "2026-10-30T00:00:00Z",
    finishedAt: "2026-10-30T00:05:00Z",
    wallSeconds: 300,
    activeSeconds: 200,
    costUsd: 0.45,
    budgetUsd: 2,
    outputs: {},
    report: { outcome: "done", summary: "Done, @someone.", acceptanceTests: [{ name: "button is blue", status: "added", failsOnBase: true }], checks: [], questions: [] },
    problems: [],
    ...over,
  });

  async function publishWith(files: Record<string, string>, over: Partial<RunRecord> = {}) {
    const fx = gitFixture();
    const cloud = new FakeCloud();
    const outDir = mkdtempSync(join(tmpdir(), "out-"));
    fx.resultBundle(outDir, 12, files);
    const result = await publish({
      gh: new GitHubClient("app-token", cloud.fetch),
      pushToken: "app-token",
      repo: REPO,
      issue: 12,
      issueTitle: "Make the button blue",
      config,
      record: record(fx, over),
      outDir,
      base: fx.baseClone(),
      log: () => undefined,
      remoteUrl: fx.remote,
    });
    return { fx, cloud, result };
  }

  it("pushes factory/issue-12, opens a draft PR, and reports with a marker", async () => {
    const { fx, cloud, result } = await publishWith({ "button.css": ".b { color: blue }\n" });
    expect(result).toEqual({ outcome: "pr", pullRequest: 100 });
    expect(git(fx.remote, "rev-parse", "--verify", "refs/heads/factory/issue-12")).toMatch(/^[0-9a-f]{40}$/);
    expect(git(fx.remote, "rev-parse", "main")).toBe(fx.baseSha);
    expect(cloud.pulls[0]).toMatchObject({ head: "factory/issue-12", base: "main", draft: true });
    const report = cloud.comments.find((c) => c.issue === 100)!.body;
    expect(latestMarker([{ id: 1, body: report, user: BOT }], BOT.login)?.marker).toEqual({ role: "builder", session: "sesn_abc", run: "run-1", costUsd: 0.45 });
    expect(report).not.toContain("@someone");
    expect([...cloud.labels.get(12)!]).toEqual(["factory:in-review"]);
  });

  it.each([".github/workflows/evil.yml", "factory.yaml", "CODEOWNERS", ".GitHub/workflows/x.yml"])(
    "rejects a bundle touching %s and pushes nothing",
    async (path) => {
      const { fx, cloud, result } = await publishWith({ [path]: "x\n", "ok.ts": "1\n" });
      expect(result.outcome).toBe("rejected");
      expect(() => git(fx.remote, "rev-parse", "--verify", "refs/heads/factory/issue-12")).toThrow();
      expect(cloud.comments[0]?.body).toContain("Rejected by the path policy");
      expect(cloud.labels.get(12)?.has("factory:failed")).toBe(true);
      expect(cloud.pulls).toEqual([]);
    },
  );

  it("labels a PR that touches a load-bearing path", async () => {
    const { cloud } = await publishWith({ "proxy.ts": "// csp\n" });
    expect(cloud.labels.get(100)?.has("needs:owner-approval")).toBe(true);
  });

  it("won't push over a branch it doesn't descend from (no force)", async () => {
    const fx = gitFixture();
    // Someone else's commit already sits on factory/issue-12 in the remote.
    git(fx.work, "checkout", "-q", "-b", "factory/issue-12");
    writeFileSync(join(fx.work, "other.ts"), "1\n");
    git(fx.work, "add", ".");
    git(fx.work, "commit", "-q", "-m", "other");
    git(fx.work, "push", "-q", fx.remote, "factory/issue-12");
    const pinned = git(fx.remote, "rev-parse", "factory/issue-12");
    git(fx.work, "checkout", "-q", "main");
    const cloud = new FakeCloud();
    const outDir = mkdtempSync(join(tmpdir(), "out-"));
    fx.resultBundle(outDir, 12, { "mine.ts": "2\n" });
    const result = await publish({
      gh: new GitHubClient("t", cloud.fetch),
      pushToken: "t",
      repo: REPO,
      issue: 12,
      issueTitle: "t",
      config,
      record: record(fx),
      outDir,
      base: fx.baseClone(),
      log: () => undefined,
      remoteUrl: fx.remote,
    });
    expect(result.outcome).toBe("failed");
    expect(git(fx.remote, "rev-parse", "factory/issue-12")).toBe(pinned);
  });

  it("posts a failure report and labels factory:failed on a cap", async () => {
    const fx = gitFixture();
    const cloud = new FakeCloud();
    const result = await publish({
      gh: new GitHubClient("t", cloud.fetch),
      pushToken: "t",
      repo: REPO,
      issue: 12,
      issueTitle: "t",
      config,
      record: record(fx, { status: "cap_exceeded", stopReason: "budget_reached" }),
      outDir: mkdtempSync(join(tmpdir(), "out-")),
      base: fx.baseClone(),
      log: () => undefined,
    });
    expect(result.outcome).toBe("failed");
    expect(cloud.comments[0]?.body).toContain("budget cap");
    expect([...cloud.labels.get(12)!]).toEqual(["factory:failed"]);
  });
});
