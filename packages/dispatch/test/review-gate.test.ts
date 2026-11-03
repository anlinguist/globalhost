// The review trigger: who and what may start an automated review (P2-01).
import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github.js";
import { decideReview, type ReviewGateContext } from "../src/review-gate.js";
import { reviewGateStep, writeReviewGateOutputs } from "../src/review.js";
import { BOT, FakeCloud, OWNER, REPO, STRANGER, registry } from "./fakes.js";
import { CI_RUN, HEAD, ISSUE, PR, ciRun, eventFile, labelEvent, pull, routePull, workflowRunEvent } from "./review-fixtures.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(cloud: FakeCloud, eventName: string, event: unknown): ReviewGateContext {
  return { gh: new GitHubClient("read", cloud.fetch), repo: REPO, eventName, event, ownerIds: [OWNER.id], botLogin: BOT.login, defaultBranch: "main" };
}

const OTHER_SHA = "3333333333333333333333333333333333333333";
const FORK = "mallory/demo";

describe("decideReview: CI success", () => {
  it("reviews a factory PR whose head is the CI run's head", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const d = await decideReview(ctx(cloud, "workflow_run", workflowRunEvent()));
    expect(d).toMatchObject({ action: "review", target: { pr: PR, sha: HEAD, issue: ISSUE, ciRunId: CI_RUN, rereview: false, viaLabel: false } });
  });

  it("accepts an owner as the CI actor", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const d = await decideReview(ctx(cloud, "workflow_run", workflowRunEvent({ actor: OWNER, triggeringActor: OWNER })));
    expect(d.action).toBe("review");
  });

  it.each<[string, Parameters<typeof workflowRunEvent>[0], RegExp]>([
    ["a failed run", { conclusion: "failure" }, /did not succeed/],
    ["a cancelled run", { conclusion: "cancelled" }, /did not succeed/],
    ["a push run", { event: "push" }, /push event/],
    ["a pull_request_target run", { event: "pull_request_target" }, /pull_request_target/],
    ["another workflow", { name: "build" }, /not the globalhost-ci/],
    ["a same-named workflow in another file", { path: ".github/workflows/evil.yml" }, /not the globalhost-ci/],
    ["a fork's run", { headRepo: FORK }, /fork/],
    ["a run with no head repository", { headRepo: null }, /fork/],
    ["a stranger's push", { actor: STRANGER }, /someone other/],
    ["a stranger's re-run of a bot run", { triggeringActor: STRANGER }, /someone other/],
    ["a user impersonating the bot's login", { actor: { ...BOT, type: "User" } }, /someone other/],
    ["a bot with another login", { actor: { login: "dependabot[bot]", id: 49699333, type: "Bot" } }, /someone other/],
    ["a non-factory branch", { headBranch: "feature/x" }, /factory\/issue/],
    ["a branch that only looks like one", { headBranch: "factory/issue-12-evil" }, /factory\/issue/],
    ["no head branch", { headBranch: null }, /factory\/issue/],
    ["a short SHA", { headSha: "abc123" }, /40-hex/],
  ])("ignores %s", async (_label, o, reason) => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const d = await decideReview(ctx(cloud, "workflow_run", workflowRunEvent(o)));
    expect(d).toMatchObject({ action: "ignore", reason: expect.stringMatching(reason) });
    expect(d).not.toHaveProperty("unlabel");
  });

  it("ignores a workflow_run that isn't completed", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    expect((await decideReview(ctx(cloud, "workflow_run", workflowRunEvent({}, "requested")))).action).toBe("ignore");
  });

  it.each<[string, Parameters<typeof pull>[0], RegExp]>([
    ["a fork PR on a same-named branch", { headRepo: FORK }, /fork/],
    ["a PR by someone other than the bot", { user: STRANGER }, /not opened by the factory bot/],
    ["a PR by an owner", { user: OWNER }, /not opened by the factory bot/],
    ["a PR by a user named like the bot", { user: { ...BOT, type: "User" } }, /not opened by the factory bot/],
    ["a retargeted PR", { baseRef: "release" }, /default branch/],
    ["a PR whose head moved", { headSha: OTHER_SHA }, /moved/],
    ["a closed PR", { state: "closed" }, /not open/],
  ])("ignores %s", async (_label, o, reason) => {
    const cloud = new FakeCloud();
    routePull(cloud, pull(o));
    const d = await decideReview(ctx(cloud, "workflow_run", workflowRunEvent()));
    expect(d).toMatchObject({ action: "ignore", reason: expect.stringMatching(reason) });
  });

  it("ignores a branch with no PR, or more than one", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const key = [...cloud.routes.keys()].find((k) => k.includes("pulls?state=open"))!;
    cloud.routes.set(key, []);
    expect(await decideReview(ctx(cloud, "workflow_run", workflowRunEvent()))).toMatchObject({ action: "ignore", reason: "no open PR for this branch" });
    cloud.routes.set(key, [pull(), pull()]);
    expect(await decideReview(ctx(cloud, "workflow_run", workflowRunEvent()))).toMatchObject({ action: "ignore", reason: expect.stringContaining("more than one") });
  });

  it("ignores events it doesn't know and malformed payloads", async () => {
    const cloud = new FakeCloud();
    expect((await decideReview(ctx(cloud, "push", {}))).action).toBe("ignore");
    expect((await decideReview(ctx(cloud, "workflow_run", { workflow_run: { id: "x" } }))).action).toBe("ignore");
    expect(cloud.calls).toEqual([]);
  });
});

describe("decideReview: owner's factory:review", () => {
  it("re-reviews the PR's current head when an owner applies the label and CI passed on it", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const d = await decideReview(ctx(cloud, "pull_request_target", labelEvent()));
    expect(d).toMatchObject({ action: "review", target: { pr: PR, sha: HEAD, ciRunId: CI_RUN, rereview: true, viaLabel: true } });
  });

  it("ignores a non-owner's label and leaves it alone (no unlabel)", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const d = await decideReview(ctx(cloud, "pull_request_target", labelEvent({ sender: STRANGER })));
    expect(d).toEqual({ action: "ignore", reason: "factory:review applied by a non-owner" });
    expect(cloud.calls).toEqual([]);
  });

  it("ignores the bot applying the label: only an owner can ask for a re-review", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    expect(await decideReview(ctx(cloud, "pull_request_target", labelEvent({ sender: BOT })))).toMatchObject({ action: "ignore" });
  });

  it("ignores other labels and actions", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    expect((await decideReview(ctx(cloud, "pull_request_target", labelEvent({ label: "factory:build" })))).action).toBe("ignore");
    expect((await decideReview(ctx(cloud, "pull_request_target", labelEvent({ action: "unlabeled" })))).action).toBe("ignore");
  });

  it.each<[string, Parameters<typeof pull>[0]]>([
    ["a fork PR", { headRepo: FORK }],
    ["a PR not by the bot", { user: STRANGER }],
    ["a retargeted PR", { baseRef: "release" }],
    ["a non-factory branch", { headRef: "feature/x" }],
    ["a closed PR", { state: "closed" }],
  ])("refuses %s and asks for the label to be removed", async (_label, o) => {
    const cloud = new FakeCloud();
    routePull(cloud, pull(o));
    expect(await decideReview(ctx(cloud, "pull_request_target", labelEvent()))).toMatchObject({ action: "ignore", unlabel: PR });
  });

  it("refuses when CI hasn't succeeded on the PR's head (and won't use a run on another SHA or a fork)", async () => {
    for (const runs of [[], [ciRun({ headSha: OTHER_SHA })], [ciRun({ headRepo: FORK })], [ciRun({ actor: STRANGER })], [ciRun({ conclusion: "failure" })]]) {
      const cloud = new FakeCloud();
      routePull(cloud, pull(), runs);
      expect(await decideReview(ctx(cloud, "pull_request_target", labelEvent()))).toMatchObject({
        action: "ignore",
        reason: "globalhost-ci has not succeeded on the PR head",
        unlabel: PR,
      });
    }
  });

  it("uses the newest qualifying CI run", async () => {
    const cloud = new FakeCloud();
    routePull(cloud, pull(), [ciRun({ id: 10 }), ciRun({ id: 30 }), ciRun({ id: 40, actor: STRANGER })]);
    expect(await decideReview(ctx(cloud, "pull_request_target", labelEvent()))).toMatchObject({ target: { ciRunId: 30 } });
  });

  it("a CI-success event never asks for a re-review", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const d = await decideReview(ctx(cloud, "workflow_run", workflowRunEvent()));
    expect(d.action === "review" && d.target.rereview).toBe(false);
  });
});

describe("reviewGateStep", () => {
  const env = (eventName: string, event: object) => ({
    GITHUB_REPOSITORY: REPO,
    GITHUB_TOKEN: "read",
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventFile(event),
    GLOBALHOST_APP_SLUG: "globalhost-ai",
  });

  it("outputs review with the PR and the job timeout (limits.perRunMinutes), writing nothing to GitHub", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const out = await reviewGateStep({ env: env("workflow_run", workflowRunEvent()), registry, log: () => undefined, fetchImpl: cloud.fetch });
    expect(out).toEqual({ action: "review", pr: PR, timeout: 45 });
    expect(cloud.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const path = join(mkdtempSync(join(tmpdir(), "out-")), "out");
    await writeReviewGateOutputs(path, out);
    expect(readFileSync(path, "utf8")).toBe(`action=review\npr=${PR}\ntimeout=45\n`);
  });

  it("outputs unlabel for an owner's label it won't act on", async () => {
    const cloud = new FakeCloud();
    routePull(cloud, pull({ state: "closed" }));
    const out = await reviewGateStep({ env: env("pull_request_target", labelEvent()), registry, log: () => undefined, fetchImpl: cloud.fetch });
    expect(out).toMatchObject({ action: "unlabel", pr: PR });
  });

  it("refuses a malformed App slug", async () => {
    const cloud = new FakeCloud();
    routePull(cloud);
    const e = { ...env("workflow_run", workflowRunEvent()), GLOBALHOST_APP_SLUG: "x]\nmalicious" };
    await expect(reviewGateStep({ env: e, registry, log: () => undefined, fetchImpl: cloud.fetch })).rejects.toThrow(/App slug/);
  });
});
