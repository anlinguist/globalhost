// The review step's write token and how it finds its earlier review: scope and pagination.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubClient, installationToken, PUBLISH_PERMISSIONS, reviewInstallationToken } from "../src/github.js";
import { findPostedReview, MAX_REVIEW_PAGES, reviewMarker } from "../src/review-post.js";
import { BOT, REPO, STRANGER } from "./fakes.js";
import { HEAD, PR } from "./review-fixtures.js";

/** A throwaway App key, made at runtime so no key material is committed. */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function tokenFake() {
  const posts: unknown[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === `/repos/${REPO}/installation`) return Response.json({ id: 77 });
    if (path === "/app/installations/77/access_tokens" && init.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ token: "minted" });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, posts };
}

describe("reviewInstallationToken", () => {
  it("asks for exactly issues write, pull_requests write and metadata read, for this repo only", async () => {
    const { fetchImpl, posts } = tokenFake();
    expect(await reviewInstallationToken("123", KEY, REPO, fetchImpl)).toBe("minted");
    expect(posts).toEqual([{ repositories: ["demo"], permissions: { issues: "write", pull_requests: "write", metadata: "read" } }]);
  });

  it("is narrower than the publisher's token: no contents", async () => {
    const { fetchImpl, posts } = tokenFake();
    await installationToken("123", KEY, REPO, fetchImpl);
    expect(posts[0]).toMatchObject({ permissions: PUBLISH_PERMISSIONS });
    expect(PUBLISH_PERMISSIONS).toHaveProperty("contents", "write");
  });
});

describe("findPostedReview pagination", () => {
  /** A PR with `pages` full pages of other people's reviews, and the bot's review for HEAD on page `at` (if any). */
  function paged(pages: number, at?: number) {
    const requested: number[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      requested.push(page);
      if (page > pages) return Response.json([]);
      const batch = Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, body: "lgtm", user: { login: STRANGER.login, type: "User" } }));
      if (page === at) batch[50] = { id: 42, body: reviewMarker({ sha: HEAD, run: "r1" }), user: { login: BOT.login, type: "Bot" } };
      return Response.json(batch);
    }) as typeof fetch;
    return { gh: new GitHubClient("t", fetchImpl), requested };
  }

  it("reads past the first pages to find the bot's earlier review", async () => {
    const { gh, requested } = paged(12, 11);
    expect(await findPostedReview(gh, REPO, PR, HEAD, BOT.login)).toBe(42);
    expect(requested.at(-1)).toBe(11);
  });

  it("returns null only after reading every page", async () => {
    const { gh, requested } = paged(12);
    expect(await findPostedReview(gh, REPO, PR, HEAD, BOT.login)).toBeNull();
    expect(requested.at(-1)).toBe(13);
  });

  it("refuses to post when there are more reviews than it can read", async () => {
    const { gh } = paged(MAX_REVIEW_PAGES + 5);
    await expect(findPostedReview(gh, REPO, PR, HEAD, BOT.login)).rejects.toThrow(/not posting/);
  });
});
