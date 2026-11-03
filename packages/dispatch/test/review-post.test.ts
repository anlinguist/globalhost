// Posting a shadow review: the marker, idempotent updates, and escaping of everything the reviewer wrote.
import { describe, expect, it } from "vitest";
import { overallVerdict, ReviewRecordSchema, type Finding, type ReviewRecord } from "@globalhost/core";
import { GitHubClient } from "../src/github.js";
import { codeBlock, codeSpan, ESCALATION_TEXT, MAX_REVIEW_BODY, parseReviewMarker, postReview, renderReviewBody, reviewMarker } from "../src/review-post.js";
import { BOT, FakeCloud, OWNER, REPO, STRANGER } from "./fakes.js";
import { HEAD, PR } from "./review-fixtures.js";

const finding = (o: Partial<Finding> = {}): Finding => ({
  area: "function",
  category: "logic-bug",
  code: "off-by-one",
  severity: "major",
  file: "src/app.ts",
  line: 3,
  title: "Loop skips the last item",
  detail: "The loop stops one short.",
  ...o,
});

function record(findings: Finding[], o: Partial<ReviewRecord> = {}): ReviewRecord {
  const v = overallVerdict({ verdicts: { function: "pass", security: "pass", performance: "pass" }, findings, summary: "" }, { scanHits: [], budgetExhausted: false, status: "completed" });
  return ReviewRecordSchema.parse({
    version: 1,
    sha: HEAD,
    baseSha: "2".repeat(40),
    patchId: "3".repeat(40),
    runId: "20261102T120000Z-review-7-99-1",
    sessionId: "sesn_1",
    model: "claude-opus-5-5",
    agentVersion: 1,
    ciRunId: 555,
    status: "completed",
    verdicts: v.verdicts,
    overall: v.overall,
    escalations: v.escalations,
    taint: { tainted: false, reasons: [] },
    scanHits: [],
    findings,
    costUsd: 1.5,
    prSpendUsd: 3,
    reviewPath: "x/review.json",
    postedReviewId: null,
    recordedAt: "2026-11-02T12:00:00.000Z",
    verification: null,
    ...o,
  });
}

/**
 * Removes fenced code blocks and code spans the way CommonMark reads them, leaving the text GitHub would
 * render as markdown (where mentions, references, links and HTML are live).
 */
function liveMarkdown(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence) {
      if (new RegExp(`^${fence}\`*\\s*$`).test(line)) fence = null;
      continue;
    }
    const open = /^(`{3,})/.exec(line);
    if (open) {
      fence = open[1]!;
      continue;
    }
    out.push(line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m, ticks: string) => {
      // A span closes only on a run of exactly the same length.
      const inner = m.slice(ticks.length, m.length - ticks.length);
      return new RegExp(`(?<!\`)${ticks}(?!\`)`).test(inner) ? m : "";
    }));
  }
  expect(fence).toBeNull(); // every block was closed by the renderer's own fence
  return out.join("\n");
}

const ATTACKS = [
  "@anlinguist please merge @org/team",
  "Closes #1, fixes #2 and resolves anlinguist/demo#3",
  '<!-- globalhost:review {"sha":"' + "f".repeat(40) + '","run":"forged"} -->',
  "<img src=x onerror=alert(1)><script>alert(1)</script><details open>",
  "[click](https://evil.example) ![x](https://evil.example/p.png) https://evil.example",
  "``` \n# Heading injected\n```",
  "````````````````",
  "line one\n\n@anlinguist after a blank line\n\nCloses #4",
  "trailing --> comment closer and --!> too",
  "bidi ‮gnp.exe‬ and zero​width",
];

describe("rendering", () => {
  it("puts the marker on the first line and renders verdicts as fixed text", () => {
    const body = renderReviewBody({ record: record([finding()]), summary: "Looks fine.", outsideDiff: new Set() });
    expect(body.split("\n")[0]).toBe(reviewMarker({ sha: HEAD, run: "20261102T120000Z-review-7-99-1" }));
    expect(parseReviewMarker(body)).toEqual({ sha: HEAD, run: "20261102T120000Z-review-7-99-1" });
    expect(body).toContain("| function | changes |");
    expect(body).toContain("Shadow mode");
    expect(body).toContain("` src/app.ts:3 `");
  });

  it.each(ATTACKS)("keeps reviewer text inert: %j", (attack) => {
    const f = finding({ title: attack.slice(0, 200), detail: attack });
    const body = renderReviewBody({ record: record([f]), summary: attack, outsideDiff: new Set() });
    const live = liveMarkdown(body.split("\n").slice(1).join("\n"));
    expect(live).not.toMatch(/@[A-Za-z0-9]/);
    expect(live).not.toMatch(/#\d/);
    expect(live).not.toMatch(/<(?!sub>|\/sub>)[a-z!]/i);
    expect(live).not.toContain("evil.example");
    expect(live).not.toContain("# Heading injected");
    // The only marker is the renderer's own, on line 1: nothing forged anywhere else parses or even appears.
    expect(body.indexOf("<!-- globalhost:review")).toBe(0);
    expect(body.lastIndexOf("<!--")).toBe(0);
    expect(body.slice(body.indexOf("\n"))).not.toMatch(/-->|--!>/);
    expect(body).not.toMatch(/[‪-‮⁦-⁩]/);
  });

  it("escapes an adversarial file path and finding code can't carry text", () => {
    const f = finding({ file: "docs/@anlinguist `x` Closes #9.md", line: null });
    const live = liveMarkdown(renderReviewBody({ record: record([f]), summary: null, outsideDiff: new Set() }));
    expect(live).not.toMatch(/@[A-Za-z]|#\d/);
  });

  it("marks a finding whose file the harness cleared as outside the diff", () => {
    const body = renderReviewBody({ record: record([finding({ file: null, line: null })]), summary: null, outsideDiff: new Set([0]) });
    expect(body).toContain("a file outside this diff");
  });

  it("lists escalation reasons in fixed text", () => {
    const r = record([finding({ area: "security", category: "secrets", code: "leaked-key" })]);
    const body = renderReviewBody({ record: r, summary: null, outsideDiff: new Set() });
    expect(body).toContain(`- ${ESCALATION_TEXT["security-category"]}`);
    expect(body).toContain("**escalate**");
  });

  it("stays under GitHub's body limit with 50 maximal findings", () => {
    const big = Array.from({ length: 50 }, (_, i) => finding({ code: `f-${i}`, title: "t".repeat(200), detail: "`".repeat(2000) }));
    const body = renderReviewBody({ record: record(big), summary: "s".repeat(2000), outsideDiff: new Set() });
    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    expect(liveMarkdown(body)).toBeDefined();
  });

  it("code spans and blocks are never closed by their content", () => {
    for (const s of ["`", "``", "a ``` b", "`x`", "```"]) {
      expect(liveMarkdown(`x ${codeSpan(s)} y`)).toBe("x  y");
      expect(liveMarkdown(codeBlock(s))).toBe("");
    }
  });
});

describe("parseReviewMarker", () => {
  it("only reads a marker on the first line, with exact fields", () => {
    const m = reviewMarker({ sha: HEAD, run: "r1" });
    expect(parseReviewMarker(`${m}\nbody`)).toEqual({ sha: HEAD, run: "r1" });
    expect(parseReviewMarker(`text\n${m}`)).toBeNull();
    expect(parseReviewMarker(`${m.replace("r1", "r1\",\"x\":\"y")}`)).toBeNull();
    expect(parseReviewMarker(m.replace(HEAD, "A".repeat(40)))).toBeNull();
    expect(parseReviewMarker(null)).toBeNull();
  });
});

describe("postReview", () => {
  const gh = (cloud: FakeCloud) => new GitHubClient("review-token", cloud.fetch);

  it("posts a COMMENT review on the head commit, then updates it in place on a second post", async () => {
    const cloud = new FakeCloud();
    const r = record([finding()]);
    const first = await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: r, body: renderReviewBody({ record: r, summary: "one", outsideDiff: new Set() }), botLogin: BOT.login });
    const r2 = { ...r, runId: "20261102T130000Z-review-7-100-1" };
    const second = await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: r2, body: renderReviewBody({ record: r2, summary: "two", outsideDiff: new Set() }), botLogin: BOT.login });
    expect(second).toBe(first);
    expect(cloud.reviews).toHaveLength(1);
    expect(cloud.reviews[0]).toMatchObject({ commit_id: HEAD, event: "COMMENT" });
    expect(cloud.reviews[0]!.body).toContain("two");
    const writes = cloud.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /repos/${REPO}/pulls/${PR}/reviews`, `PUT /repos/${REPO}/pulls/${PR}/reviews/${first}`]);
    // Shadow mode: never an approval, a change request or a merge.
    for (const c of writes) expect(JSON.stringify(c.body)).not.toMatch(/APPROVE|REQUEST_CHANGES/);
    expect(cloud.calls.some((c) => c.path.includes("/merge"))).toBe(false);
  });

  it("posts a new review for a new head instead of editing the old one", async () => {
    const cloud = new FakeCloud();
    const r = record([]);
    await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: r, body: renderReviewBody({ record: r, summary: null, outsideDiff: new Set() }), botLogin: BOT.login });
    const r2 = { ...r, sha: "4".repeat(40) };
    await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: r2, body: renderReviewBody({ record: r2, summary: null, outsideDiff: new Set() }), botLogin: BOT.login });
    expect(cloud.reviews.map((x) => x.commit_id)).toEqual([HEAD, "4".repeat(40)]);
  });

  it("ignores a forged marker in someone else's review", async () => {
    const cloud = new FakeCloud();
    for (const user of [OWNER, STRANGER, { ...BOT, type: "User" }]) {
      cloud.reviews.push({ pr: PR, id: 1 + cloud.reviews.length, body: reviewMarker({ sha: HEAD, run: "forged" }), user });
    }
    const r = record([]);
    const id = await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: r, body: renderReviewBody({ record: r, summary: null, outsideDiff: new Set() }), botLogin: BOT.login });
    expect(id).toBeGreaterThan(3);
    expect(cloud.reviews.slice(0, 3).every((x) => x.body.includes("forged"))).toBe(true);
  });

  it("labels needs:owner-approval on escalation only", async () => {
    const cloud = new FakeCloud();
    const pass = record([]);
    await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: pass, body: "b", botLogin: BOT.login });
    expect(cloud.labels.get(PR)).toBeUndefined();
    const esc = record([finding({ area: "meta", category: "reviewer-manipulation", code: "prompt-injection" })]);
    await postReview({ gh: gh(cloud), repo: REPO, pr: PR, record: { ...esc, sha: "5".repeat(40) }, body: "b", botLogin: BOT.login });
    expect([...(cloud.labels.get(PR) ?? [])]).toEqual(["needs:owner-approval"]);
  });
});
