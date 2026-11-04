import { describe, expect, it } from "vitest";
import { ObjectStore } from "../src/gcp.js";
import { GitHubClient } from "../src/github.js";
import {
  ACTIONS_BOT_LOGIN,
  mergedFactoryPrDays,
  MetricsError,
  metricsStep,
  publishMetricsIssue,
  readRepoInfo,
  type MetricsDeps,
} from "../src/metrics-step.js";
import { FakeCloud } from "./fakes.js";
import { builderObject, PUBLIC_REPO, reviewObject, reviewRun, runRecord, spendObject } from "./metrics-fixtures.js";

const FACTORY = "anlinguist/globalhost";
const PRIVATE_REPO = "anlinguist/secret-product";
const NOW = new Date("2026-11-14T03:17:00.000Z");
const ISSUES = `/repos/${FACTORY}/issues?labels=factory%3Ametrics&state=all&sort=created&direction=asc&per_page=100`;
const pullsPath = (repo: string, page = 1) => `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;

// Recorded from the GitHub API and cut down to the fields read here: numu-know #38 and #49.
const MERGED_FACTORY_PR = {
  number: 38,
  state: "closed",
  merged_at: "2026-11-02T22:05:14Z",
  updated_at: "2026-11-02T22:05:50Z",
  closed_at: "2026-11-02T22:05:14Z",
  head: { ref: "factory/issue-32", repo: { full_name: "anlinguist/numu-know" } },
  base: { ref: "main" },
  user: { login: "globalhost-ai[bot]", type: "Bot" },
};
const MERGED_OWNER_PR = {
  number: 49,
  state: "closed",
  merged_at: "2026-11-04T05:05:29Z",
  updated_at: "2026-11-04T05:11:34Z",
  closed_at: "2026-11-04T05:05:29Z",
  head: { ref: "release-verify-cloud-run", repo: { full_name: "anlinguist/numu-know" } },
  base: { ref: "main" },
  user: { login: "anlinguist", type: "User" },
};
const BOT_ISSUE = { number: 70, title: "Factory metrics", user: { login: ACTIONS_BOT_LOGIN, type: "Bot" } };

function cloud(): FakeCloud {
  const c = new FakeCloud();
  c.routes.set(`GET /repos/${PUBLIC_REPO}`, { full_name: PUBLIC_REPO, private: false, visibility: "public" });
  c.routes.set(`GET ${pullsPath(PUBLIC_REPO)}`, []);
  c.routes.set(`GET ${ISSUES}`, [BOT_ISSUE]);
  c.routes.set(`PATCH /repos/${FACTORY}/issues/70`, { number: 70 });
  return c;
}

const put = (c: FakeCloud, bucket: string, object: { name: string; body: string }) => c.objects.set(`${bucket}/${object.name}`, { body: object.body, generation: 1 });
const putRun = (c: FakeCloud, object: { name: string; body: string }) => put(c, "globalhost-runs", object);
const putSpend = (c: FakeCloud, object: { name: string; body: string }) => put(c, "globalhost-control", object);

function deps(c: FakeCloud, over: Partial<MetricsDeps> & { lines?: string[] } = {}): MetricsDeps {
  return {
    env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: FACTORY },
    log: (line) => over.lines?.push(line),
    fetchImpl: c.fetch,
    gcpToken: async () => "gcp",
    now: () => NOW,
    ...over,
  };
}

const patched = (c: FakeCloud) => c.calls.filter((x) => x.method === "PATCH");

describe("ObjectStore.list", () => {
  const store = (c: FakeCloud) => new ObjectStore(async () => "gcp", c.fetch);

  it("follows pagination and filters by prefix", async () => {
    const c = cloud();
    c.listPageSize = 2;
    for (const n of ["a/1", "a/2", "a/3", "a/4", "a/5", "b/1"]) c.objects.set(`globalhost-runs/${n}`, { body: "{}", generation: 1 });
    expect(await store(c).list("globalhost-runs", "a/")).toEqual(["a/1", "a/2", "a/3", "a/4", "a/5"]);
  });

  it("returns nothing for an empty bucket, whose listing has no items at all", async () => {
    expect(await store(cloud()).list("globalhost-runs", "")).toEqual([]);
  });

  it("throws when it can't list", async () => {
    const c = cloud();
    c.failing.set("GET storage.googleapis.com/storage/v1/b/globalhost-runs/o", 403);
    await expect(store(c).list("globalhost-runs", "")).rejects.toThrow("HTTP 403");
  });
});

describe("merged factory PRs", () => {
  const gh = (c: FakeCloud) => new GitHubClient("t", c.fetch);

  it("counts only this repo's own factory/issue-<n> branches that merged", async () => {
    const c = cloud();
    c.routes.set(`GET ${pullsPath(PUBLIC_REPO)}`, [
      MERGED_FACTORY_PR,
      MERGED_OWNER_PR,
      { ...MERGED_FACTORY_PR, number: 2, merged_at: null }, // closed unmerged
      { ...MERGED_FACTORY_PR, number: 3, head: { ref: "factory/issue-3", repo: { full_name: "mallory/numu-know" } } }, // a fork
      { ...MERGED_FACTORY_PR, number: 4, head: { ref: "factory/issue-4", repo: null } }, // a deleted fork
      { ...MERGED_FACTORY_PR, number: 5, head: { ref: "factory/issue-5x", repo: MERGED_FACTORY_PR.head.repo } },
      { ...MERGED_FACTORY_PR, number: 6, head: { ref: "factory/issue-6/evil", repo: MERGED_FACTORY_PR.head.repo } },
    ]);
    expect(await mergedFactoryPrDays(gh(c), PUBLIC_REPO, "2026-10-10")).toEqual(["2026-11-02"]);
  });

  it("stops paging once a page reaches back before the window", async () => {
    const c = cloud();
    const full = Array.from({ length: 100 }, () => MERGED_FACTORY_PR);
    c.routes.set(`GET ${pullsPath(PUBLIC_REPO, 1)}`, full);
    c.routes.set(`GET ${pullsPath(PUBLIC_REPO, 2)}`, full);
    const days = await mergedFactoryPrDays(gh(c), PUBLIC_REPO, "2026-11-10");
    expect(days).toHaveLength(100);
    expect(c.calls.filter((x) => x.path.includes("/pulls"))).toHaveLength(1);
  });

  it("keeps paging while a full page is still inside the window", async () => {
    const c = cloud();
    c.routes.set(`GET ${pullsPath(PUBLIC_REPO, 1)}`, Array.from({ length: 100 }, () => MERGED_FACTORY_PR));
    c.routes.set(`GET ${pullsPath(PUBLIC_REPO, 2)}`, [MERGED_FACTORY_PR]);
    expect(await mergedFactoryPrDays(gh(c), PUBLIC_REPO, "2026-10-10")).toHaveLength(101);
  });

  it("gives up and reports unknown rather than an undercount, past the page limit", async () => {
    const c = cloud();
    for (let page = 1; page <= 20; page++) c.routes.set(`GET ${pullsPath(PUBLIC_REPO, page)}`, Array.from({ length: 100 }, () => MERGED_FACTORY_PR));
    expect(await mergedFactoryPrDays(gh(c), PUBLIC_REPO, "2026-10-10")).toBeNull();
  });
});

describe("which repos can be named", () => {
  const gh = (c: FakeCloud) => new GitHubClient("t", c.fetch);

  it.each<[string, (c: FakeCloud) => void]>([
    ["says it's private", (c) => c.routes.set(`GET /repos/${PRIVATE_REPO}`, { private: true, visibility: "private" })],
    ["says private with no visibility", (c) => c.routes.set(`GET /repos/${PRIVATE_REPO}`, { private: true })],
    ["says it's internal", (c) => c.routes.set(`GET /repos/${PRIVATE_REPO}`, { private: false, visibility: "internal" })],
    ["answers 404 (the token can't see it)", () => undefined],
    ["answers 403", (c) => c.failing.set(`GET /repos/${PRIVATE_REPO}`, 403)],
    ["answers 500", (c) => c.failing.set(`GET /repos/${PRIVATE_REPO}`, 500)],
    ["answers something unexpected", (c) => c.routes.set(`GET /repos/${PRIVATE_REPO}`, { hello: "world" })],
  ])("a repo isn't public when GitHub %s, and the job carries on", async (_name, arrange) => {
    const c = cloud();
    arrange(c);
    const info = await readRepoInfo(gh(c), [PRIVATE_REPO, PUBLIC_REPO], "2026-11-10");
    expect(info.get(PRIVATE_REPO)).toEqual({ public: false, mergedDays: null });
    expect(info.get(PUBLIC_REPO)).toEqual({ public: true, mergedDays: [] });
    expect(c.calls.some((x) => x.path.startsWith(`/repos/${PRIVATE_REPO}/pulls`))).toBe(false);
  });

  it("leaves a public repo's merge count unknown when its PR list fails", async () => {
    const c = cloud();
    c.routes.delete(`GET ${pullsPath(PUBLIC_REPO)}`);
    c.failing.set(`GET /repos/${PUBLIC_REPO}/pulls`, 500);
    expect((await readRepoInfo(gh(c), [PUBLIC_REPO], "2026-11-10")).get(PUBLIC_REPO)).toEqual({ public: true, mergedDays: null });
  });
});

describe("the rolling issue", () => {
  const gh = (c: FakeCloud) => new GitHubClient("t", c.fetch);

  it("edits the one the bot opened, and reopens it", async () => {
    const c = cloud();
    expect(await publishMetricsIssue(gh(c), FACTORY, "body")).toBe(70);
    expect(patched(c)).toEqual([{ method: "PATCH", path: `/repos/${FACTORY}/issues/70`, body: { body: "body", state: "open" } }]);
    expect(c.calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("ignores an issue with the label that someone else opened, and PRs", async () => {
    const c = cloud();
    c.routes.set(`GET ${ISSUES}`, [
      { number: 1, user: { login: "mallory", type: "User" } },
      { number: 2, user: { login: ACTIONS_BOT_LOGIN, type: "Bot" }, pull_request: {} },
      { number: 3, user: { login: ACTIONS_BOT_LOGIN, type: "User" } }, // a name alone isn't the bot
      { number: 4, user: null },
      BOT_ISSUE,
    ]);
    expect(await publishMetricsIssue(gh(c), FACTORY, "body")).toBe(70);
  });

  it("creates the label and the issue when there's none", async () => {
    const c = cloud();
    c.routes.set(`GET ${ISSUES}`, []);
    c.routes.set(`POST /repos/${FACTORY}/labels`, { name: "factory:metrics" });
    c.routes.set(`POST /repos/${FACTORY}/issues`, { number: 71, labels: [{ name: "factory:metrics" }] });
    expect(await publishMetricsIssue(gh(c), FACTORY, "body")).toBe(71);
    const posts = c.calls.filter((x) => x.method === "POST");
    expect(posts.map((p) => p.path)).toEqual([`/repos/${FACTORY}/labels`, `/repos/${FACTORY}/issues`]);
    expect(posts[1]!.body).toEqual({ title: "Factory metrics", body: "body", labels: ["factory:metrics"] });
  });

  it("carries on when the label already exists, and adds it if GitHub dropped it on create", async () => {
    const c = cloud();
    c.routes.set(`GET ${ISSUES}`, []);
    c.failing.set(`POST /repos/${FACTORY}/labels`, 422);
    c.routes.set(`POST /repos/${FACTORY}/issues`, { number: 71, labels: [] });
    expect(await publishMetricsIssue(gh(c), FACTORY, "body")).toBe(71);
    expect(c.labels.get(71)).toEqual(new Set(["factory:metrics"]));
  });
});

describe("metricsStep", () => {
  it("writes the report and edits the issue from one body", async () => {
    const c = cloud();
    putRun(c, builderObject(runRecord({ costUsd: 3, finishedAt: "2026-11-13T10:00:00.000Z" })));
    putRun(c, reviewObject(reviewRun({ repo: PUBLIC_REPO, costUsd: 1, finishedAt: "2026-11-13T11:00:00.000Z" })));
    putRun(c, { name: `${PUBLIC_REPO}/run-1/turn-1/report.json`, body: "not a run record, never read" });
    putSpend(c, spendObject("2026-11-13", PUBLIC_REPO, { usd: 4 }));

    const { report, markdown } = await metricsStep(deps(c));

    expect(report.findings).toEqual([]);
    expect(report.cycle.metrics).toMatchObject({ totalRuns: 2, spendUsd: 4 });
    const written = JSON.parse(c.objects.get("globalhost-control/metrics/2026-11-13.json")!.body) as { day: string };
    expect(written.day).toBe("2026-11-13");
    expect(patched(c)[0]!.body).toEqual({ body: markdown, state: "open" });
    expect(c.objects.has("globalhost-control/metrics/2026-11-13.problems.json")).toBe(false);
  });

  it("passes on empty buckets, the first night", async () => {
    const c = cloud();
    const { report } = await metricsStep(deps(c));
    expect(report.findings).toEqual([]);
    expect(patched(c)).toHaveLength(1);
  });

  it("publishes a report with findings: failing the job is the caller's part", async () => {
    const c = cloud();
    putSpend(c, spendObject("2026-11-13", PUBLIC_REPO, { usd: 130 }));
    putRun(c, builderObject(runRecord({ costUsd: 130, finishedAt: "2026-11-13T10:00:00.000Z" })));
    const { report } = await metricsStep(deps(c));
    expect(report.findings.map((f) => f.code)).toEqual(["cycle-spend", "daily-spend"]);
    expect((patched(c)[0]!.body as { body: string }).body).toContain("**cycle-spend:**");
  });

  it("reads old run records as baselines, and spend only within the window", async () => {
    const c = cloud();
    putRun(c, builderObject(runRecord({ turn: 1, costUsd: 10, finishedAt: "2026-10-20T10:00:00.000Z" })));
    putRun(c, builderObject(runRecord({ turn: 2, costUsd: 12, finishedAt: "2026-11-13T10:00:00.000Z" })));
    putSpend(c, spendObject("2026-11-13", PUBLIC_REPO, { usd: 2 }));
    putSpend(c, { name: "spend/2026-01-01/anlinguist__numu-know.json", body: "ancient and corrupt, and out of the window" });
    const { report } = await metricsStep(deps(c));
    expect(report.drift).toMatchObject({ ledgerUsd: 2, runRecordsUsd: 2 });
    expect(report.findings).toEqual([]);
  });

  it("skips an object deleted between listing and reading", async () => {
    const c = cloud();
    const object = builderObject(runRecord());
    putRun(c, object);
    const listThenVanish = (async (input: string | URL, init?: RequestInit) => {
      const resp = await c.fetch(input, init);
      if (String(input).includes("/o?")) c.objects.clear();
      return resp;
    }) as typeof fetch;
    const { report } = await metricsStep(deps(c, { fetchImpl: listThenVanish }));
    expect(report.findings).toEqual([]);
  });

  describe("a private repo's name", () => {
    it("stays out of the report, the issue and the log, while its objects are bad in every way", async () => {
      const c = cloud();
      const lines: string[] = [];
      putRun(c, builderObject(runRecord({ repo: PRIVATE_REPO, costUsd: 1, finishedAt: "2026-11-13T10:00:00.000Z" })));
      putRun(c, { name: `${PRIVATE_REPO}/broken/turn-1/run.json`, body: "{" });
      putSpend(c, { name: `spend/2026-11-13/${PRIVATE_REPO.replace("/", "__")}.json`, body: "{" });

      const { report, markdown } = await metricsStep(deps(c, { lines }));

      expect(report.findings.map((f) => f.code)).toEqual(["corrupt-spend", "unrecognized-run"]);
      for (const output of [JSON.stringify(report), markdown, lines.join("\n"), JSON.stringify(patched(c)), c.objects.get("globalhost-control/metrics/2026-11-13.json")!.body]) {
        expect(output).not.toContain("secret-product");
      }
      // The owner can still find them, in the private bucket.
      const problems = JSON.parse(c.objects.get("globalhost-control/metrics/2026-11-13.problems.json")!.body) as Record<string, string[]>;
      expect(problems.unrecognizedRuns).toEqual([`${PRIVATE_REPO}/broken/turn-1/run.json`]);
      expect(problems.corruptSpend).toEqual([`spend/2026-11-13/${PRIVATE_REPO.replace("/", "__")}.json`]);
    });

    it("stays out of the error when reading its object fails", async () => {
      const c = cloud();
      const object = builderObject(runRecord({ repo: PRIVATE_REPO }));
      putRun(c, object);
      c.failing.set(`GET storage.googleapis.com/storage/v1/b/globalhost-runs/o/${encodeURIComponent(object.name)}`, 500);
      const err = await metricsStep(deps(c)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetricsError);
      expect((err as Error).message).toBe("metrics: reading the runs bucket failed (HTTP 500)");
      expect((err as Error).message).not.toContain("secret-product");
    });
  });

  describe("failing loudly", () => {
    it.each([
      ["the runs bucket can't be listed", "GET storage.googleapis.com/storage/v1/b/globalhost-runs/o", "metrics: reading the runs bucket failed (HTTP 403)"],
      ["the control bucket can't be listed", "GET storage.googleapis.com/storage/v1/b/globalhost-control/o", "metrics: reading the control bucket failed (HTTP 403)"],
    ])("throws when %s, and publishes nothing", async (_name, prefix, message) => {
      const c = cloud();
      c.failing.set(prefix, 403);
      await expect(metricsStep(deps(c))).rejects.toThrow(message);
      expect(patched(c)).toEqual([]);
      expect(c.objects.size).toBe(0);
    });

    it("throws when the report can't be written, but still edits the issue", async () => {
      const c = cloud();
      c.failing.set("POST storage.googleapis.com/upload/storage/v1/b/globalhost-control/o", 403);
      await expect(metricsStep(deps(c))).rejects.toThrow("metrics: writing gs://globalhost-control/metrics/2026-11-13.json failed (HTTP 403)");
      expect(patched(c)).toHaveLength(1);
    });

    it("throws when the issue can't be edited, but still writes the report", async () => {
      const c = cloud();
      c.failing.set(`PATCH /repos/${FACTORY}/issues/70`, 403);
      await expect(metricsStep(deps(c))).rejects.toThrow("metrics: updating the metrics issue failed (HTTP 403)");
      expect(c.objects.has("globalhost-control/metrics/2026-11-13.json")).toBe(true);
    });

    it.each([
      ["GITHUB_TOKEN", { GITHUB_REPOSITORY: FACTORY }],
      ["GITHUB_REPOSITORY", { GITHUB_TOKEN: "t" }],
    ])("refuses to start without %s", async (_name, env) => {
      await expect(metricsStep(deps(cloud(), { env }))).rejects.toBeInstanceOf(MetricsError);
    });
  });

  it("writes nothing on a dry run, and prints the report", async () => {
    const c = cloud();
    let printed = "";
    const { markdown } = await metricsStep(deps(c, { env: { METRICS_DRY_RUN: "1" }, out: (t) => (printed += t) }));
    expect(printed).toBe(markdown);
    expect(c.objects.size).toBe(0);
    expect(c.calls.filter((x) => x.method !== "GET")).toEqual([]);
  });

  it("mints one GCP token for the whole job", async () => {
    const c = cloud();
    putRun(c, builderObject(runRecord()));
    putSpend(c, spendObject("2026-11-13", PUBLIC_REPO, { usd: 1 }));
    let minted = 0;
    await metricsStep(deps(c, { gcpToken: async () => `gcp-${++minted}` }));
    expect(minted).toBe(1);
  });
});
