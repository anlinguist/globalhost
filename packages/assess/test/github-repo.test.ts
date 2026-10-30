import { describe, expect, it } from "vitest";
import { githubRepoFacts } from "../src/checks/github-repo.js";
import { fakeGitHub, fixture, numuKnowRoutes, rawFixture } from "./helpers.js";

describe("githubRepoFacts", () => {
  it("reads the recorded anonymous numu-know responses", async () => {
    const { gh, calls } = fakeGitHub(numuKnowRoutes());
    const f = await githubRepoFacts(gh, "anlinguist/numu-know");
    expect(f).toMatchObject({
      repo: "anlinguist/numu-know",
      visibility: "public",
      defaultBranch: "main",
      archived: false,
      fork: false,
      cloneUrl: "https://github.com/anlinguist/numu-know.git",
      owner: { login: "anlinguist", id: 47403803, type: "User" },
      workflows: { ok: true, items: [], truncated: false },
      contributors: { ok: true, items: [{ login: "anlinguist", id: 47403803, type: "User", contributions: 17 }] },
      collaborators: { ok: false, reason: "needs a token with push access" },
      outsideContributors: { ok: false, reason: "needs the collaborator list" },
    });
    // Read-only: every call is a GET.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("finds outside contributors once collaborators are known, ignoring bots", async () => {
    const hostile = rawFixture<{ workflows: unknown; contributors: unknown }>("rest/hostile.json");
    const { gh } = fakeGitHub(
      {
        ...numuKnowRoutes(),
        "GET /repos/anlinguist/numu-know/actions/workflows?per_page=100": hostile.workflows,
        "GET /repos/anlinguist/numu-know/contributors?per_page=100": hostile.contributors,
        "GET /repos/anlinguist/numu-know/collaborators?per_page=100&affiliation=all": fixture("rest/collaborators.json"),
      },
      "token",
    );
    const f = await githubRepoFacts(gh, "anlinguist/numu-know");
    expect(f.collaborators).toEqual({
      ok: true,
      truncated: false,
      items: [
        { login: "anlinguist", id: 47403803, type: "User", role: "admin" },
        { login: "helper-dev", id: 5550001, type: "User", role: "write" },
      ],
    });
    expect(f.outsideContributors).toEqual({ ok: true, truncated: false, items: [{ login: "mallory", id: 666, type: "User", contributions: 3 }] });
    expect(f.workflows.ok && f.workflows.items.map((w) => w.state)).toEqual(["active", "disabled_manually"]);
  });

  it("reports a malformed optional response as unavailable instead of failing the assessment", async () => {
    const { gh } = fakeGitHub({ ...numuKnowRoutes(), "GET /repos/anlinguist/numu-know/actions/workflows?per_page=100": { workflows: "nope" } });
    const f = await githubRepoFacts(gh, "anlinguist/numu-know");
    expect(f.workflows).toEqual({ ok: false, reason: "unexpected workflows response shape" });
  });

  it("fails when the repo itself can't be read", async () => {
    const { gh } = fakeGitHub({});
    await expect(githubRepoFacts(gh, "anlinguist/missing")).rejects.toThrow("HTTP 404");
  });
});
