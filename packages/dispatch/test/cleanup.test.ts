import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dispatchHoldReleasable,
  isRemovableTagEntry,
  MAX_CHANGES_PER_RUN,
  overCap,
  planReviewPr,
  prFromDomain,
  prFromTag,
  previewVerdict,
  renderCleanupReport,
  trafficWithout,
  type CleanupReport,
  type PrTruth,
} from "../src/cleanup.js";
import { cleanupStep, CleanupError, groupReviewObjects, parseStackProducts, readPrTruth, type CleanupDeps } from "../src/cleanup-step.js";
import { ControlPlane, ObjectStore } from "../src/gcp.js";
import { GitHubClient } from "../src/github.js";
import { FakeCloud } from "./fakes.js";

const NOW = new Date("2026-11-20T03:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW_MS - hours * HOUR).toISOString();

const REPO = "anlinguist/numu-know";
const PROJECT = "numu-know-dev";
const SERVICE_URL = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/us-central1/services/numu-know-web-preview`;
const CONFIG_URL = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;
const STACK = `config:
  gcp:region: us-central1
  globalhost-factory:previews:
    - product: numu-know
      devProject: ${PROJECT}
      repo: {name: ${REPO}, id: "338675328", defaultBranch: main}
      parts: [web]
`;
const domainOf = (pr: number) => `numu-know-web-pr-${pr}.globalhost.ai`;
const LIVE_DOMAINS = ["localhost", "numu-know-dev.firebaseapp.com", "numu-know-dev.web.app"];

// Recorded from the Cloud Run v2 API (numu-know-web-preview) and cut down: the main target as it is live, with a
// tagged no-traffic revision in the shape `gcloud run deploy --tag --no-traffic` leaves (no `percent` at 0).
const MAIN_TARGET = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "numu-know-web-preview-main", percent: 100 };
const tagged = (tag: string, over: object = {}) => ({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: `rev-${tag}`, tag, ...over });
// Recorded from the GitHub API (numu-know #51), cut down to the fields read.
const closedPr = (number: number, closedAt: string, fullName = REPO) => ({ number, state: "closed", closed_at: closedAt, merged_at: closedAt, base: { repo: { full_name: fullName } } });
const openPr = (number: number) => ({ number, state: "open", closed_at: null, merged_at: null, base: { repo: { full_name: REPO } } });

/** FakeCloud plus the two dev-project APIs, with what's live in them and every write recorded. */
class Live extends FakeCloud {
  traffic: unknown[] = [MAIN_TARGET];
  etag = "etag-1";
  domains: string[] = [...LIVE_DOMAINS];
  /** Runs before each read of the service or the config, to change things concurrently. */
  beforeRead: ((what: "service" | "config", n: number) => void) | undefined;
  failingApi = new Map<string, number>();
  private reads = { service: 0, config: 0 };
  writes: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];

  apiFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const failure = this.failingApi.get(`${method} ${url.split("?")[0]}`);
    if (failure) return new Response("{}", { status: failure });
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.startsWith(SERVICE_URL)) {
      if (method === "GET") {
        this.beforeRead?.("service", ++this.reads.service);
        return Response.json({ name: "x", etag: this.etag, template: { revision: "kept" }, traffic: this.traffic, trafficStatuses: [] });
      }
      const body = JSON.parse(String(init.body)) as { etag: string; traffic: unknown[] };
      this.writes.push({ url, body, headers });
      if (body.etag !== this.etag) return new Response("{}", { status: 409 });
      this.traffic = body.traffic;
      this.etag = `${this.etag}+`;
      return Response.json({ name: "operation" });
    }
    if (url.startsWith(CONFIG_URL)) {
      if (method === "GET") {
        this.beforeRead?.("config", ++this.reads.config);
        return Response.json({ name: "config", subtype: "IDENTITY_PLATFORM", authorizedDomains: this.domains });
      }
      const body = JSON.parse(String(init.body)) as { authorizedDomains: string[] };
      this.writes.push({ url, body, headers });
      this.domains = body.authorizedDomains;
      return Response.json({ name: "config" });
    }
    return this.fetch(input, init);
  }) as typeof fetch;

  pr(body: unknown, repo = REPO) {
    const number = (body as { number: number }).number;
    this.routes.set(`GET /repos/${repo}/pulls/${number}`, body);
  }

  /** Every call that isn't a read, anywhere. */
  allWrites() {
    return [...this.writes.map((w) => w.url), ...this.calls.filter((c) => c.method !== "GET").map((c) => c.path), ...this.gcsWrites];
  }

  gcsWrites: string[] = [];
}

/** Records GCS writes and deletes too, which FakeCloud's own call list leaves out. */
function recording(c: Live): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    if (String(input).includes("storage.googleapis.com") && (init.method ?? "GET") !== "GET") c.gcsWrites.push(`${init.method} ${String(input)}`);
    return c.apiFetch(input, init);
  }) as typeof fetch;
}

function deps(c: Live, over: Partial<CleanupDeps> & { lines?: string[] } = {}): CleanupDeps {
  return {
    env: { GITHUB_TOKEN: "t", CLEANUP_APPLY: "true" },
    log: (line) => over.lines?.push(line),
    fetchImpl: recording(c),
    gcpToken: async () => "gcp",
    now: () => NOW,
    readStack: async () => STACK,
    ...over,
  };
}

const LEDGER = (repo: string, pr: number) => `globalhost-control/reviews/${repo}/pr-${pr}.json`;
const CLAIM = (repo: string, pr: number, sha: string) => `globalhost-control/reviews/${repo}/pr-${pr}/${sha}.claim.json`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const reservation = (runId: string, at: string) => ({ runId, sha: SHA_A, reservedUsd: 2, reservedAt: at, day: at.slice(0, 10) });
const ledgerBody = (reservations: unknown[] = []) => JSON.stringify({ version: 1, reviewSpendUsd: 0, truncatedSpendUsd: 0, runs: [], reservations });

function putReview(c: Live, pr: number, reservations: ReturnType<typeof reservation>[] = [], repo = REPO) {
  c.objects.set(LEDGER(repo, pr), { body: ledgerBody(reservations), generation: 1 });
  c.objects.set(CLAIM(repo, pr, SHA_A), { body: "{}", generation: 1 });
}

describe("names", () => {
  it.each([
    ["pr-1", 1],
    ["pr-51", 51],
    ["pr-1234567890", 1234567890],
  ])("%s is a preview tag", (tag, pr) => expect(prFromTag(tag)).toBe(pr));

  it.each(["pr-", "pr-1x", "xpr-1", "pr-1-canary", "pr-0", "pr-007", "PR-1", "pr-1 ", " pr-1", "pr--1", "pr-1.5", "pr-12345678901", "main", ""])("%j isn't", (tag) => {
    expect(prFromTag(tag)).toBeNull();
  });

  it("matches a domain only exactly", () => {
    expect(prFromDomain("numu-know-web-pr-5.globalhost.ai", "numu-know", "web")).toBe(5);
  });

  it.each([
    "numu-know-web-pr-5.globalhost.ai.evil.example",
    "evil.numu-know-web-pr-5.globalhost.ai",
    "xnumu-know-web-pr-5.globalhost.ai",
    "numu-know-web-pr-5xglobalhost.ai",
    "numu-know-web-pr-5.globalhost.ai.",
    "numu-know-web-pr-.globalhost.ai",
    "numu-know-web-pr-05.globalhost.ai",
    "numu-know-web-pr-5x.globalhost.ai",
    "numu-know-api-pr-5.globalhost.ai", // another part
    "other-web-pr-5.globalhost.ai", // another product
    "NUMU-KNOW-WEB-PR-5.GLOBALHOST.AI",
    "numu-know.com", // prod and owner domains
    "www.numu-know.com",
    "numu-know-dev.web.app",
    "localhost",
    "",
  ])("leaves %j alone", (domain) => {
    expect(prFromDomain(domain, "numu-know", "web")).toBeNull();
  });
});

describe("what counts as an orphan", () => {
  const closed = (hours: number): PrTruth => ({ kind: "closed", closedAtMs: NOW_MS - hours * HOUR, repo: REPO });

  it.each([
    [closed(0.5), "closed-recently"],
    [closed(1), "closed-recently"], // exactly an hour keeps
    [{ kind: "closed", closedAtMs: NOW_MS - HOUR - 1, repo: REPO } as PrTruth, "orphan"],
    [closed(24 * 30), "orphan"],
    [{ kind: "open" } as PrTruth, "open"],
    [{ kind: "unknown", why: "x" } as PrTruth, "unknown"],
  ])("%j is %s", (truth, verdict) => expect(previewVerdict(truth, NOW_MS)).toBe(verdict));

  it("never removes a target that carries traffic or follows latest", () => {
    expect(isRemovableTagEntry(tagged("pr-1"))).toBe(true);
    expect(isRemovableTagEntry(tagged("pr-1", { percent: 0 }))).toBe(true);
    expect(isRemovableTagEntry(tagged("pr-1", { percent: 1 }))).toBe(false);
    expect(isRemovableTagEntry({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", tag: "pr-1" })).toBe(false);
    expect(isRemovableTagEntry({ tag: "pr-1" })).toBe(false);
    const traffic = [MAIN_TARGET, tagged("pr-1"), tagged("pr-2", { percent: 5 }), tagged("pr-3")];
    expect(trafficWithout(traffic, new Set(["pr-1", "pr-2"]))).toEqual([MAIN_TARGET, tagged("pr-2", { percent: 5 }), tagged("pr-3")]);
  });
});

describe("what GitHub is taken to say", () => {
  const ask = (c: FakeCloud, pr = 5) => readPrTruth(new GitHubClient("t", c.fetch), REPO, pr, NOW_MS);

  it("reads a clean closed PR, with GitHub's casing", async () => {
    const c = new FakeCloud();
    c.routes.set(`GET /repos/${REPO}/pulls/5`, closedPr(5, ago(2), "Anlinguist/Numu-Know"));
    expect(await ask(c)).toEqual({ kind: "closed", closedAtMs: NOW_MS - 2 * HOUR, repo: "Anlinguist/Numu-Know" });
  });

  it("reads an open PR", async () => {
    const c = new FakeCloud();
    c.routes.set(`GET /repos/${REPO}/pulls/5`, openPr(5));
    expect(await ask(c)).toEqual({ kind: "open" });
  });

  it.each([404, 500, 502, 403, 429])("HTTP %d isn't an answer", async (status) => {
    const c = new FakeCloud();
    c.failing.set(`GET /repos/${REPO}/pulls/5`, status);
    expect(await ask(c)).toMatchObject({ kind: "unknown" });
  });

  it("treats an issue's number as no PR: GitHub answers 404", async () => {
    const c = new FakeCloud(); // no route: 404, as GET /pulls/<issue number> is
    expect(await ask(c)).toEqual({ kind: "unknown", why: "GitHub has no such PR (404)" });
  });

  it.each<[string, unknown]>([
    ["another number", closedPr(6, ago(2))],
    ["another repo", closedPr(5, ago(2), "mallory/numu-know")],
    ["a state it doesn't know", { ...closedPr(5, ago(2)), state: "weird" }],
    ["closed with no time", { ...closedPr(5, ago(2)), closed_at: null }],
    ["a time that isn't one", { ...closedPr(5, ago(2)), closed_at: "soon" }],
    ["a time in the future", closedPr(5, ago(-2))],
    ["a body with no fields", {}],
    ["a body that's a list", []],
  ])("%s isn't a clean closed PR", async (_label, body) => {
    const c = new FakeCloud();
    c.routes.set(`GET /repos/${REPO}/pulls/5`, body);
    expect(await ask(c)).toMatchObject({ kind: "unknown" });
  });

  it("doesn't throw when the request itself fails", async () => {
    const gh = new GitHubClient("t", (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch);
    expect(await readPrTruth(gh, REPO, 5, NOW_MS)).toEqual({ kind: "unknown", why: "GitHub's answer couldn't be read" });
  });
});

describe("review state policy", () => {
  const closed = (days: number): PrTruth => ({ kind: "closed", closedAtMs: NOW_MS - days * 24 * HOUR, repo: REPO });
  const ledger = (...reservations: ReturnType<typeof reservation>[]) => ({ version: 1 as const, reviewSpendUsd: 0, truncatedSpendUsd: 0, runs: [], reservations });

  it("keeps everything while a PR is open, whatever it holds, and says nothing: the watcher reports the hold", () => {
    expect(planReviewPr({ kind: "open" }, ledger(reservation("old", ago(1000))), NOW_MS)).toEqual({ release: [], purge: false });
  });

  it("keeps and reports anything GitHub can't vouch for", () => {
    expect(planReviewPr({ kind: "unknown", why: "GitHub answered HTTP 500" }, ledger(reservation("old", ago(1000))), NOW_MS)).toEqual({ release: [], purge: false, kept: "GitHub answered HTTP 500" });
  });

  it("keeps a corrupt ledger, even a week after closing", () => {
    expect(planReviewPr(closed(30), "corrupt", NOW_MS)).toEqual({ release: [], purge: false, kept: "its ledger is corrupt" });
  });

  it.each([
    [6.99, false],
    [7, true], // 7+ days
    [30, true],
  ])("closed %d days ago: purged %s", (days, purge) => {
    expect(planReviewPr(closed(days), ledger(), NOW_MS).purge).toBe(purge);
    expect(planReviewPr(closed(days), null, NOW_MS).purge).toBe(purge); // claims with no ledger
  });

  it.each([
    [23.99, []],
    [24, []], // exactly 24 hours isn't older
    [24.01, ["r"]],
  ])("a reservation %d hours old on a closed PR: released %j", (hours, release) => {
    expect(planReviewPr(closed(2), ledger(reservation("r", ago(hours))), NOW_MS).release).toEqual(release);
  });

  it("an open reservation under 24 hours blocks the purge, and is reported", () => {
    expect(planReviewPr(closed(10), ledger(reservation("young", ago(2)), reservation("old", ago(30))), NOW_MS)).toEqual({
      release: ["old"],
      purge: false,
      kept: "an open reservation is under 24 hours old",
    });
  });

  it("a stale reservation is released and the purge goes ahead", () => {
    expect(planReviewPr(closed(10), ledger(reservation("old", ago(30))), NOW_MS)).toEqual({ release: ["old"], purge: true });
  });
});

describe("the cap", () => {
  it.each([
    [MAX_CHANGES_PER_RUN - 1, false],
    [MAX_CHANGES_PER_RUN, false],
    [MAX_CHANGES_PER_RUN + 1, true],
  ])("%d changes: over %s", (n, over) => expect(overCap(n)).toBe(over));
});

describe("dead session holds", () => {
  it.each([
    [47.9, false],
    [48, false],
    [48.1, true],
  ])("%d hours old: releasable %s", (hours, ok) => expect(dispatchHoldReleasable(ago(hours), NOW_MS)).toBe(ok));

  it("keeps a time it can't read", () => expect(dispatchHoldReleasable("soon", NOW_MS)).toBe(false));
});

describe("reading what's there", () => {
  it("reads the real stack config", () => {
    const products = parseStackProducts(readFileSync(new URL("../../../infra/factory/Pulumi.prod.yaml", import.meta.url), "utf8"));
    expect(products).toEqual([{ product: "numu-know", devProject: PROJECT, repo: REPO, parts: ["web"], region: "us-central1" }]);
  });

  it("groups only exact ledger and claim names", () => {
    expect(
      groupReviewObjects([
        `reviews/${REPO}/pr-5.json`,
        `reviews/${REPO}/pr-5/${SHA_A}.claim.json`,
        `reviews/${REPO}/pr-5/${SHA_B}.claim.json`,
        `reviews/${REPO}/pr-6/${SHA_A}.claim.json`,
        `reviews/${REPO}/pr-07.json`,
        `reviews/${REPO}/pr-5/notes.txt`,
        `reviews/${REPO}/pr-5/${SHA_A}.claim.json.bak`,
        `reviews/${REPO}/other.json`,
        `reviews/${REPO}/pr-5/x/${SHA_A}.claim.json`,
        `reviews/Mixed/Case/pr-5.json`,
        `reviews/pr-5.json`,
        `reviewsx/${REPO}/pr-5.json`,
      ]),
    ).toEqual([
      { repo: REPO, pr: 5, hasLedger: true, shas: [SHA_A, SHA_B] },
      { repo: REPO, pr: 6, hasLedger: false, shas: [SHA_A] },
    ]);
  });
});

describe("cleanupStep", () => {
  it("does nothing, and says so, when there's nothing to do", async () => {
    const c = new Live();
    const { report, markdown } = await cleanupStep(deps(c));
    expect(report).toMatchObject({ mode: "apply", overCap: false, planned: 0, tags: [], domains: [], reviewState: [], kept: [], failures: [] });
    expect(c.allWrites()).toEqual([]);
    expect(markdown).toContain("preview tags: none");
  });

  describe("preview tags", () => {
    it("removes an orphan by etag and only touches traffic, keeping every other target whole", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5"), tagged("pr-6"), tagged("pr-1x"), tagged("pr-1-canary"), tagged("xpr-1"), tagged("pr-")];
      c.pr(closedPr(5, ago(3)));
      c.pr(openPr(6));
      const { report } = await cleanupStep(deps(c));
      expect(report.tags).toEqual([5]);
      expect(c.writes).toHaveLength(1);
      // The service as read, with only its traffic changed: the mask limits the update, and the etag conditions it.
      expect(c.writes[0]).toMatchObject({ url: `${SERVICE_URL}?updateMask=traffic`, body: { etag: "etag-1", template: { revision: "kept" } } });
      expect(c.traffic).toEqual([MAIN_TARGET, tagged("pr-6"), tagged("pr-1x"), tagged("pr-1-canary"), tagged("xpr-1"), tagged("pr-")]);
      // Only exact names were even asked about.
      expect(c.calls.filter((x) => x.path.includes("/pulls/")).map((x) => x.path)).toEqual([`/repos/${REPO}/pulls/5`, `/repos/${REPO}/pulls/6`]);
    });

    it("keeps a PR closed 30 minutes ago, and reports it", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.pr(closedPr(5, ago(0.5)));
      const { report } = await cleanupStep(deps(c));
      expect(report.tags).toEqual([]);
      expect(report.kept).toEqual([{ what: "preview tag", pr: 5, why: "closed under an hour ago" }]);
      expect(c.allWrites()).toEqual([]);
    });

    it.each([
      [404, "GitHub has no such PR (404)"],
      [500, "GitHub answered HTTP 500"],
      [403, "GitHub answered HTTP 403"],
      [429, "GitHub answered HTTP 429"],
    ])("keeps and reports on GitHub %d, without failing", async (status, why) => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.failing.set(`GET /repos/${REPO}/pulls/5`, status);
      const { report } = await cleanupStep(deps(c));
      expect(report.kept).toEqual([{ what: "preview tag", pr: 5, why }]);
      expect(report.failures).toEqual([]);
      expect(c.allWrites()).toEqual([]);
    });

    it("keeps a tag whose number belongs to an issue", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-9")];
      c.routes.set(`GET /repos/${REPO}/issues/9`, { number: 9, state: "closed" }); // an issue; /pulls/9 is a 404
      const { report } = await cleanupStep(deps(c));
      expect(report.kept).toEqual([{ what: "preview tag", pr: 9, why: "GitHub has no such PR (404)" }]);
      expect(c.allWrites()).toEqual([]);
    });

    it("keeps a tag that carries traffic, whatever its PR says", async () => {
      const c = new Live();
      c.traffic = [{ ...MAIN_TARGET, percent: 90 }, tagged("pr-5", { percent: 10 })];
      c.pr(closedPr(5, ago(3)));
      const { report } = await cleanupStep(deps(c));
      expect(report.kept[0]).toMatchObject({ what: "preview tag", pr: 5 });
      expect(c.allWrites()).toEqual([]);
    });

    it("re-reads and retries when the service changes between read and write, keeping the new tag", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.pr(closedPr(5, ago(3)));
      c.beforeRead = (what, n) => {
        // The plan is read 1. Between the apply's read (2) and its PATCH, the preview workflow deploys PR 7.
        if (what === "service" && n === 2) {
          const conflicting = c.etag;
          queueMicrotask(() => {
            if (c.etag === conflicting) {
              c.traffic = [...c.traffic, tagged("pr-7")];
              c.etag = "etag-2";
            }
          });
        }
      };
      const { report } = await cleanupStep(deps(c));
      expect(report.tags).toEqual([5]);
      expect(c.writes.map((w) => w.body.etag)).toEqual(["etag-1", "etag-2"]);
      expect(c.traffic).toEqual([MAIN_TARGET, tagged("pr-7")]);
    });

    it("gives up after repeated conflicts, fails the job and removes nothing", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.pr(closedPr(5, ago(3)));
      const original = c.apiFetch;
      c.apiFetch = (async (input: string | URL, init: RequestInit = {}) => (init.method === "PATCH" ? new Response("{}", { status: 412 }) : original(input, init))) as typeof fetch;
      const { report } = await cleanupStep(deps(c));
      expect(report.tags).toEqual([]);
      expect(report.failures).toEqual(["removing preview tags: the service kept changing; left for the next run"]);
    });

    it("reports a write it was refused, as a status", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.pr(closedPr(5, ago(3)));
      c.failingApi.set(`PATCH ${SERVICE_URL}`, 403);
      const { report } = await cleanupStep(deps(c));
      expect(report.tags).toEqual([]);
      expect(report.failures).toEqual(["removing preview tags failed (HTTP 403)"]);
    });
  });

  describe("authorized domains", () => {
    it("removes only an orphan's exact domain, with the quota project, and keeps every other", async () => {
      const c = new Live();
      const others = [...LIVE_DOMAINS, "numu-know.com", domainOf(5) + ".evil.example", "numu-know-web-pr-5x.globalhost.ai", domainOf(6)];
      c.domains = [...others, domainOf(5)];
      c.pr(closedPr(5, ago(3)));
      c.pr(openPr(6));
      const { report } = await cleanupStep(deps(c));
      expect(report.domains).toEqual([5]);
      expect(c.domains).toEqual(others);
      expect(c.writes).toHaveLength(1);
      expect(c.writes[0]!.url).toBe(`${CONFIG_URL}?updateMask=authorizedDomains`);
      expect(c.writes[0]!.headers["x-goog-user-project"]).toBe(PROJECT);
    });

    it("keeps a concurrent change made between the plan's read and the write", async () => {
      const c = new Live();
      c.domains = [...LIVE_DOMAINS, domainOf(5)];
      c.pr(closedPr(5, ago(3)));
      c.beforeRead = (what, n) => {
        if (what === "config" && n === 2) c.domains = [...c.domains, domainOf(8)]; // the workflow, deploying PR 8
      };
      await cleanupStep(deps(c));
      expect(c.domains).toEqual([...LIVE_DOMAINS, domainOf(8)]);
    });

    it("doesn't write when the workflow's teardown got there first", async () => {
      const c = new Live();
      c.domains = [...LIVE_DOMAINS, domainOf(5)];
      c.pr(closedPr(5, ago(3)));
      c.beforeRead = (what, n) => {
        if (what === "config" && n === 2) c.domains = [...LIVE_DOMAINS];
      };
      const { report } = await cleanupStep(deps(c));
      expect(report.domains).toEqual([]);
      expect(c.writes).toEqual([]);
    });

    it("fails, and writes nothing, if the config has no domain list to work from", async () => {
      const c = new Live();
      const original = c.apiFetch;
      c.apiFetch = (async (input: string | URL, init: RequestInit = {}) => (String(input).startsWith(CONFIG_URL) ? Response.json({ name: "config" }) : original(input, init))) as typeof fetch;
      const { report } = await cleanupStep(deps(c));
      expect(report.failures).toEqual(["reading the authorized domains failed (no HTTP status)"]);
      expect(c.allWrites()).toEqual([]);
    });

    it("carries on with the rest when a read fails, and fails the job", async () => {
      const c = new Live();
      c.failingApi.set(`GET ${SERVICE_URL}`, 403);
      c.domains = [...LIVE_DOMAINS, domainOf(5)];
      c.pr(closedPr(5, ago(3)));
      const { report } = await cleanupStep(deps(c));
      expect(report.failures).toEqual(["reading a preview service failed (HTTP 403)"]);
      expect(report.domains).toEqual([5]);
    });
  });

  describe("review state", () => {
    const week = 24 * 7;

    it("deletes claims and ledger a week after closing, and nothing else", async () => {
      const c = new Live();
      putReview(c, 5);
      c.objects.set(CLAIM(REPO, 5, SHA_B), { body: "{}", generation: 1 });
      putReview(c, 6);
      c.objects.set(`globalhost-control/reviews/${REPO}/pr-5/notes.txt`, { body: "x", generation: 1 });
      c.objects.set("globalhost-control/state.json", { body: "{}", generation: 1 });
      c.pr(closedPr(5, ago(week + 1)));
      c.pr(closedPr(6, ago(week - 1)));
      const { report } = await cleanupStep(deps(c));
      expect(report.reviewState).toEqual([5]);
      expect([...c.objects.keys()].sort()).toEqual([LEDGER(REPO, 6), CLAIM(REPO, 6, SHA_A), `globalhost-control/reviews/${REPO}/pr-5/notes.txt`, "globalhost-control/state.json"].sort());
    });

    it("keeps an open PR's state, and its hold, quietly", async () => {
      const c = new Live();
      putReview(c, 5, [reservation("crashed", ago(100))]);
      c.pr(openPr(5));
      const { report } = await cleanupStep(deps(c));
      expect(report).toMatchObject({ reservations: [], reviewState: [], kept: [] });
      expect(c.allWrites()).toEqual([]);
    });

    it("keeps a ledger with a young reservation, its claims too, and reports it", async () => {
      const c = new Live();
      putReview(c, 5, [reservation("young", ago(3))]);
      c.pr(closedPr(5, ago(week + 1)));
      const { report } = await cleanupStep(deps(c));
      expect(report.reviewState).toEqual([]);
      expect(report.kept).toEqual([{ what: "review state", pr: 5, why: "an open reservation is under 24 hours old" }]);
      expect(c.objects.has(LEDGER(REPO, 5))).toBe(true);
      expect(c.objects.has(CLAIM(REPO, 5, SHA_A))).toBe(true);
    });

    it("re-checks: a reservation that appears after the plan blocks the delete", async () => {
      const c = new Live();
      const control = new ControlPlane(new ObjectStore(async () => "gcp", c.fetch), () => NOW);
      putReview(c, 5);
      c.objects.set(LEDGER(REPO, 5), { body: ledgerBody([reservation("late", ago(1))]), generation: 2 });
      expect(await control.deleteReviewState({ repo: REPO, pr: 5 }, [SHA_A])).toBe("held");
      expect(c.objects.has(CLAIM(REPO, 5, SHA_A))).toBe(true);
    });

    it("keeps a corrupt ledger and reports it", async () => {
      const c = new Live();
      c.objects.set(LEDGER(REPO, 5), { body: "{nope", generation: 1 });
      c.pr(closedPr(5, ago(week + 1)));
      const { report } = await cleanupStep(deps(c));
      expect(report.kept).toEqual([{ what: "review state", pr: 5, why: "its ledger is corrupt" }]);
      expect(c.objects.has(LEDGER(REPO, 5))).toBe(true);
    });

    it("keeps state GitHub can't confirm (a repo the token can't read)", async () => {
      const c = new Live();
      putReview(c, 5, [reservation("old", ago(100))], "anlinguist/secret-product");
      const { report } = await cleanupStep(deps(c));
      expect(report.kept).toEqual([{ what: "review state", pr: 5, why: "GitHub has no such PR (404)" }]);
      expect(c.allWrites()).toEqual([]);
    });

    describe("a stale reservation", () => {
      const day = ago(30).slice(0, 10);
      const spend = (repo: string) => `globalhost-control/spend/${day}/${repo.replace("/", "__")}.json`;

      it("is released from ledger and day, adds no cost, and is listed on the record for the metrics issue", async () => {
        const c = new Live();
        const canon = "Anlinguist/Numu-Know";
        putReview(c, 5, [reservation("crashed", ago(30))]);
        c.objects.set(spend(canon), { body: JSON.stringify({ usd: 1, runs: [], reservations: [{ runId: "crashed", usd: 2, at: ago(30) }, { runId: "other", usd: 2, at: ago(1) }] }), generation: 1 });
        c.pr(closedPr(5, ago(3), canon));
        const { report } = await cleanupStep(deps(c));
        expect(report.reservations).toEqual([{ pr: 5, usd: 2 }]);
        expect(report.reviewState).toEqual([]); // closed three hours ago: kept for the week
        const ledger = JSON.parse(c.objects.get(LEDGER(REPO, 5))!.body) as { reservations: unknown[] };
        expect(ledger.reservations).toEqual([]);
        // On the spend record under GitHub's casing, not the lowercased name review objects use.
        expect(c.objects.has(spend(REPO))).toBe(false);
        expect(JSON.parse(c.objects.get(spend(canon))!.body)).toEqual({
          usd: 1,
          runs: [],
          reservations: [{ runId: "other", usd: 2, at: ago(1) }],
          released: [{ runId: "crashed", usd: 2, reservedAt: ago(30), releasedAt: NOW.toISOString() }],
        });
      });

      it("is released and the state purged in one run, a week after closing", async () => {
        const c = new Live();
        putReview(c, 5, [reservation("crashed", ago(30))]);
        c.pr(closedPr(5, ago(week + 1)));
        const { report } = await cleanupStep(deps(c));
        expect(report).toMatchObject({ reservations: [{ pr: 5, usd: 2 }], reviewState: [5] });
        expect(c.objects.has(LEDGER(REPO, 5))).toBe(false);
      });

      it("creates no empty spend record when the day doesn't hold it", async () => {
        const c = new Live();
        putReview(c, 5, [reservation("crashed", ago(30))]);
        c.pr(closedPr(5, ago(3)));
        await cleanupStep(deps(c));
        expect(c.objects.has(spend(REPO))).toBe(false);
      });
    });
  });

  describe("dead session holds", () => {
    const name = (d: string) => `spend/${d}/anlinguist__numu-know.json`;
    const today = NOW.toISOString().slice(0, 10);

    it("releases only dispatch holds past 48 hours, listed for the issue, and leaves a review's alone", async () => {
      const c = new Live();
      const record = {
        usd: 3,
        runs: [],
        reservations: [
          { runId: "dead", usd: 4, at: ago(60), kind: "dispatch" },
          { runId: "young", usd: 4, at: ago(40), kind: "dispatch" },
          { runId: "review-hold", usd: 2, at: ago(60) },
        ],
      };
      c.objects.set(`globalhost-control/${name(today)}`, { body: JSON.stringify(record), generation: 1 });
      const { report } = await cleanupStep(deps(c));
      expect(report.dispatchHolds).toEqual([{ usd: 4 }]);
      const after = JSON.parse(c.objects.get(`globalhost-control/${name(today)}`)!.body) as typeof record & { released: unknown[] };
      expect(after.usd).toBe(3);
      expect(after.reservations.map((r) => r.runId)).toEqual(["young", "review-hold"]);
      expect(after.released).toEqual([{ runId: "dead", usd: 4, reservedAt: ago(60), releasedAt: NOW.toISOString(), kind: "dispatch" }]);
    });

    it("refuses to touch anything but a spend object", async () => {
      const control = new ControlPlane(new ObjectStore(async () => "gcp", new FakeCloud().fetch));
      await expect(control.releaseDispatchHold("state.json", "x")).rejects.toThrow("not a spend object");
      await expect(control.releaseDispatchHold("reviews/a/b/pr-1.json", "x")).rejects.toThrow("not a spend object");
    });
  });

  describe("the cap", () => {
    function withOrphans(n: number) {
      const c = new Live();
      c.traffic = [MAIN_TARGET, ...Array.from({ length: n }, (_, i) => tagged(`pr-${i + 1}`))];
      for (let i = 1; i <= n; i++) c.pr(closedPr(i, ago(3)));
      return c;
    }

    it.each([MAX_CHANGES_PER_RUN - 1, MAX_CHANGES_PER_RUN])("goes ahead at %d", async (n) => {
      const c = withOrphans(n);
      const { report } = await cleanupStep(deps(c));
      expect(report).toMatchObject({ mode: "apply", overCap: false, planned: n });
      expect(report.tags).toHaveLength(n);
      expect(c.traffic).toEqual([MAIN_TARGET]);
    });

    it("changes nothing at all above it, and reports it", async () => {
      const c = withOrphans(MAX_CHANGES_PER_RUN + 1);
      putReview(c, 900);
      c.pr(closedPr(900, ago(1000)));
      const { report, markdown } = await cleanupStep(deps(c));
      expect(report).toMatchObject({ overCap: true, planned: MAX_CHANGES_PER_RUN + 2 });
      expect(c.allWrites()).toEqual([]);
      expect(markdown).toContain("Nothing was changed");
    });

    it("counts tags, domains, purges and releases together", async () => {
      const c = withOrphans(MAX_CHANGES_PER_RUN - 2);
      c.domains = [...LIVE_DOMAINS, domainOf(1)];
      putReview(c, 900, [reservation("crashed", ago(30))]);
      c.pr(closedPr(900, ago(1000)));
      const { report } = await cleanupStep(deps(c));
      expect(report).toMatchObject({ planned: MAX_CHANGES_PER_RUN + 1, overCap: true });
      expect(c.allWrites()).toEqual([]);
    });
  });

  describe("dry runs", () => {
    function busy() {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.domains = [...LIVE_DOMAINS, domainOf(5)];
      c.pr(closedPr(5, ago(24 * 30)));
      putReview(c, 5, [reservation("crashed", ago(30))]);
      c.objects.set(`globalhost-control/spend/${NOW.toISOString().slice(0, 10)}/anlinguist__numu-know.json`, {
        body: JSON.stringify({ usd: 0, runs: [], reservations: [{ runId: "dead", usd: 4, at: ago(60), kind: "dispatch" }] }),
        generation: 1,
      });
      return c;
    }

    it.each<[string, NodeJS.ProcessEnv]>([
      ["CLEANUP_DRY_RUN=1", { GITHUB_TOKEN: "t", CLEANUP_APPLY: "true", CLEANUP_DRY_RUN: "1" }],
      ["CLEANUP_APPLY unset", { GITHUB_TOKEN: "t" }],
      ["CLEANUP_APPLY empty", { GITHUB_TOKEN: "t", CLEANUP_APPLY: "" }],
      ["CLEANUP_APPLY=TRUE", { GITHUB_TOKEN: "t", CLEANUP_APPLY: "TRUE" }],
      ["CLEANUP_APPLY=1", { GITHUB_TOKEN: "t", CLEANUP_APPLY: "1" }],
      ["CLEANUP_APPLY=false", { GITHUB_TOKEN: "t", CLEANUP_APPLY: "false" }],
      ["no GitHub token at all", {}],
    ])("%s: says what it would do and makes no write call", async (_label, env) => {
      const c = busy();
      const before = JSON.stringify([...c.objects]);
      const { report, markdown } = await cleanupStep(deps(c, { env }));
      expect(report).toMatchObject({ mode: "dry-run", tags: [5], domains: [5], reviewState: [5], reservations: [{ pr: 5, usd: 2 }], dispatchHolds: [{ usd: 4 }] });
      expect(markdown).toContain("dry run");
      expect(markdown).toContain("Would remove preview tags: #5");
      expect(c.allWrites()).toEqual([]);
      expect(JSON.stringify([...c.objects])).toBe(before);
      expect(c.traffic).toHaveLength(2);
    });
  });

  it("needs a GitHub token to apply", async () => {
    await expect(cleanupStep(deps(new Live(), { env: { CLEANUP_APPLY: "true" } }))).rejects.toThrow(new CleanupError("cleanup: GITHUB_TOKEN is not set"));
  });

  it("fails with fixed text when the stack config can't be read", async () => {
    await expect(cleanupStep(deps(new Live(), { readStack: async () => Promise.reject(new Error("/home/x/secret")) }))).rejects.toThrow(new CleanupError("cleanup: the stack config couldn't be read"));
    await expect(cleanupStep(deps(new Live(), { readStack: async () => "config: {}" }))).rejects.toThrow(CleanupError);
  });

  it("reads a token failure as one, once, with no raw message", async () => {
    const { report } = await cleanupStep(deps(new Live(), { gcpToken: async () => Promise.reject(new Error("gcloud said something about /private/path")) }));
    expect(report.failures).toEqual(["getting a GCP token failed"]);
  });

  describe("the public log", () => {
    const PRIVATE = "anlinguist/secret-product";

    it("never carries a repo, object or project name", async () => {
      const c = new Live();
      c.traffic = [MAIN_TARGET, tagged("pr-5")];
      c.domains = [...LIVE_DOMAINS, domainOf(5)];
      c.pr(closedPr(5, ago(3)));
      putReview(c, 7, [reservation("crashed", ago(100))], PRIVATE); // unreadable: kept
      putReview(c, 8, [reservation("crashed", ago(30))]); // readable: released
      c.pr(closedPr(8, ago(200)));
      c.failing.set("GET storage.googleapis.com/storage/v1/b/globalhost-control/o/spend", 500);
      const lines: string[] = [];
      const { markdown, report } = await cleanupStep(deps(c, { lines }));
      const everything = [...lines, markdown, ...report.failures].join("\n");
      expect(report.tags).toEqual([5]);
      for (const secret of ["secret-product", "numu-know", "anlinguist", PROJECT, "reviews/", "crashed", SHA_A]) expect(everything).not.toContain(secret);
    });

    it("renders only numbers, amounts and fixed text", () => {
      const report: CleanupReport = {
        mode: "apply",
        overCap: false,
        planned: 3,
        tags: [5, 2, 5],
        domains: [],
        reviewState: [9],
        reservations: [{ pr: 9, usd: 2 }],
        dispatchHolds: [{ usd: 4 }],
        kept: [{ what: "preview tag", pr: 3, why: "closed under an hour ago" }],
        failures: ["removing preview tags failed (HTTP 403)"],
      };
      expect(renderCleanupReport(report)).toBe(
        [
          "## Cleanup (applied)",
          "",
          "- Removed preview tags: #2, #5",
          "- Removed authorized domains: none",
          "- Removed review state: #9",
          "- Released review reservations: #9",
          "- Released dead session holds: 1",
          "- Held amount: $6.00. Not in the ledger, and those sessions may have spent up to it.",
          "",
          "### Kept",
          "",
          "- preview tag of #3: closed under an hour ago",
          "",
          "### Failures",
          "",
          "- removing preview tags failed (HTTP 403)",
          "",
        ].join("\n"),
      );
    });
  });
});

describe("ControlPlane: dispatch holds", () => {
  const SPEND = (day: string) => `globalhost-control/spend/${day}/anlinguist__demo.json`;
  const DEMO = "anlinguist/demo";
  let clock = new Date("2026-11-02T10:00:00Z");
  const control = (c: FakeCloud) => new ControlPlane(new ObjectStore(async () => "gcp", c.fetch), () => clock);
  const body = (c: FakeCloud, day: string) => JSON.parse(c.objects.get(SPEND(day))!.body) as { usd: number; reservations: { runId: string; kind?: string }[]; runs: unknown[] };

  it("counts the hold against the day until the run settles it", async () => {
    clock = new Date("2026-11-02T10:00:00Z");
    const c = new FakeCloud();
    const cp = control(c);
    const hold = await cp.holdDispatchRun(DEMO, "run-1", 4);
    expect(hold).toEqual({ runId: "run-1", day: "2026-11-02" });
    expect(body(c, "2026-11-02").reservations).toEqual([{ runId: "run-1", usd: 4, at: clock.toISOString(), kind: "dispatch" }]);
    expect(await cp.spentTodayUsd(DEMO)).toBe(4);
    await cp.recordSpend(DEMO, "session-run", 1.5, hold);
    expect(body(c, "2026-11-02")).toMatchObject({ usd: 1.5, reservations: [] });
    expect(await cp.spentTodayUsd(DEMO)).toBe(1.5);
  });

  it("a killed run leaves its hold: nothing settles it", async () => {
    clock = new Date("2026-11-02T10:00:00Z");
    const c = new FakeCloud();
    const cp = control(c);
    await cp.holdDispatchRun(DEMO, "killed", 4);
    expect(await cp.spentTodayUsd(DEMO)).toBe(4); // overcounts until the day ends
    expect(body(c, "2026-11-02").reservations.map((r) => r.runId)).toEqual(["killed"]);
  });

  it("settles over midnight: cost on the new day, hold dropped from the old", async () => {
    clock = new Date("2026-11-02T23:59:00Z");
    const c = new FakeCloud();
    const cp = control(c);
    const hold = await cp.holdDispatchRun(DEMO, "run-1", 4);
    clock = new Date("2026-11-03T00:30:00Z");
    await cp.recordSpend(DEMO, "session-run", 2, hold);
    expect(body(c, "2026-11-02")).toMatchObject({ reservations: [] });
    expect(body(c, "2026-11-03")).toMatchObject({ usd: 2 });
  });

  it("keeps other runs' reservations when settling", async () => {
    clock = new Date("2026-11-02T10:00:00Z");
    const c = new FakeCloud();
    const cp = control(c);
    const a = await cp.holdDispatchRun(DEMO, "a", 4);
    await cp.holdDispatchRun(DEMO, "b", 4);
    await cp.recordSpend(DEMO, "a", 1, a);
    expect(body(c, "2026-11-02").reservations.map((r) => r.runId)).toEqual(["b"]);
  });

  it("refuses to start on a corrupt record, and changes nothing", async () => {
    clock = new Date("2026-11-02T10:00:00Z");
    const c = new FakeCloud();
    c.objects.set(SPEND("2026-11-02"), { body: '{"usd":"lots"}', generation: 1 });
    await expect(control(c).holdDispatchRun(DEMO, "a", 4)).rejects.toThrow("not a valid spend record");
    expect(c.objects.get(SPEND("2026-11-02"))!.body).toBe('{"usd":"lots"}');
  });

  it("recordSpend without a hold doesn't touch reservations", async () => {
    clock = new Date("2026-11-02T10:00:00Z");
    const c = new FakeCloud();
    const cp = control(c);
    await cp.holdDispatchRun(DEMO, "a", 4);
    await cp.recordSpend(DEMO, "b", 1);
    expect(body(c, "2026-11-02").reservations.map((r) => r.runId)).toEqual(["a"]);
  });
});
