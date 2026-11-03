import { describe, expect, it } from "vitest";
import { parseFactoryYaml, validateFactoryConfig, z, type FactoryConfig, type PartCtx, type Profile, type RepoSnapshot } from "@globalhost/core";
import { GitHubClient } from "../src/github.js";
import { MAX_SNAPSHOT_FILE_BYTES, githubSnapshot, profileRunSettings, profileToolchain } from "../src/profile-settings.js";
import { FACTORY_YAML, FakeCloud, REPO, registry } from "./fakes.js";

function stubProfile(id: string, allowedHosts: string[]): Profile {
  return {
    id,
    version: "0.0.0",
    configSchema: z.object({}).passthrough(),
    preview: { kinds: ["url"], outputs: ["url"], inputs: [] },
    release: { allowedAdapters: [] },
    detect: async (repo: RepoSnapshot, path: string) => ({
      confidence: 1,
      evidence: [],
      config: {},
      manifest: await repo.readFile(path === "." ? "package.json" : `${path}/package.json`),
    }),
    scaffold: { install: [] },
    skills: [],
    environment: { name: `globalhost-${id}`, allowedHosts },
    guidance: (part: PartCtx) => `${id} ${part.name} at ${part.path}: ${String((part.detection as { manifest?: string }).manifest)}`,
    verify: { steps: () => [] },
    guardrails: [],
  } as unknown as Profile;
}

function config(): FactoryConfig {
  const parsed = parseFactoryYaml(Buffer.from(FACTORY_YAML));
  if (!parsed.ok) throw new Error("bad yaml");
  const result = validateFactoryConfig(parsed.value, registry);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

function cloudWithTree(files: Record<string, string>, truncated = false): FakeCloud {
  const cloud = new FakeCloud();
  cloud.routes.set(`GET /repos/${REPO}/git/trees/main?recursive=1`, {
    truncated,
    tree: [
      { path: "app", type: "tree" },
      ...Object.entries(files).map(([path, body]) => ({ path, type: "blob", size: Buffer.byteLength(body) })),
    ],
  });
  for (const [path, body] of Object.entries(files)) {
    cloud.routes.set(`GET /repos/${REPO}/contents/${path}?ref=main`, { content: Buffer.from(body).toString("base64"), encoding: "base64" });
  }
  return cloud;
}

describe("githubSnapshot", () => {
  it("lists blobs only and reads each file once", async () => {
    const cloud = cloudWithTree({ "package.json": '{"name":"demo"}', "app/page.tsx": "x" });
    const snap = await githubSnapshot(new GitHubClient("t", cloud.fetch), REPO, "main");
    expect(snap.files).toEqual(["package.json", "app/page.tsx"]);
    expect(await snap.readFile("package.json")).toBe('{"name":"demo"}');
    await snap.readFile("package.json");
    expect(cloud.calls.filter((c) => c.path.includes("/contents/package.json"))).toHaveLength(1);
  });

  it("reads missing and oversized files as absent without fetching them", async () => {
    const big = "a".repeat(MAX_SNAPSHOT_FILE_BYTES + 1);
    const cloud = cloudWithTree({ "big.json": big });
    const snap = await githubSnapshot(new GitHubClient("t", cloud.fetch), REPO, "main");
    expect(await snap.readFile("big.json")).toBeUndefined();
    expect(await snap.readFile("../../etc/passwd")).toBeUndefined();
    expect(cloud.calls.filter((c) => c.path.includes("/contents/"))).toEqual([]);
  });

  it("refuses a truncated tree rather than detecting on part of the repo", async () => {
    const cloud = cloudWithTree({ "package.json": "{}" }, true);
    await expect(githubSnapshot(new GitHubClient("t", cloud.fetch), REPO, "main")).rejects.toThrow(/too large/);
  });
});

describe("profileRunSettings", () => {
  const snapshot = { files: ["package.json"], readFile: async (p: string) => (p === "package.json" ? "manifest" : undefined) };

  it("uses the part's profile for guidance and its environment as is", async () => {
    const settings = await profileRunSettings([stubProfile("web-app", ["example.com"])], config(), snapshot);
    expect(settings.guidance).toBe("web-app web at .: manifest");
    expect(settings.environment).toEqual({ name: "globalhost-web-app", allowedHosts: ["example.com"] });
  });

  it("joins every part's guidance and unions the hosts of every profile in use", async () => {
    const web = config();
    const twoProfiles = { ...web, parts: { ...web.parts, api: { ...web.parts.web!, path: "api", profile: "service" } } };
    const settings = await profileRunSettings([stubProfile("web-app", ["b.example"]), stubProfile("service", ["a.example", "b.example"])], twoProfiles, snapshot);
    expect(settings.guidance).toBe("web-app web at .: manifest\nservice api at api: undefined");
    expect(settings.environment).toEqual({ name: "globalhost-service-web-app", allowedHosts: ["a.example", "b.example"] });
  });

  it("fails rather than run without a part's profile", async () => {
    await expect(profileRunSettings([], config(), snapshot)).rejects.toThrow(/web-app is not registered/);
  });
});

describe("profileToolchain", () => {
  const withToolchain = (id: string, range: string): Profile => ({
    ...stubProfile(id, []),
    toolchain: async (repo: RepoSnapshot, part: { name: string; path: string }) => ({
      tools: [{ tool: "node", range, source: part.path === "." ? ".nvmrc" : `${part.path}/.nvmrc`, check: "node --version", install: "x" }],
      notes: (await repo.readFile("package.json")) === "manifest" ? [] : ["unexpected snapshot"],
    }),
  });

  it("is absent when no part's profile reads versions", async () => {
    expect(profileToolchain([stubProfile("web-app", [])], config())).toBeUndefined();
    expect((await profileRunSettings([stubProfile("web-app", [])], config(), { files: [], readFile: async () => undefined })).toolchain).toBeUndefined();
  });

  it("merges parts in factory.yaml order over the snapshot it's given", async () => {
    const web = config();
    const twoParts = { ...web, parts: { ...web.parts, api: { ...web.parts.web!, path: "api", profile: "service" } } };
    const resolve = profileToolchain([withToolchain("web-app", "20"), withToolchain("service", "22")], twoParts)!;
    const tc = await resolve({ files: ["package.json"], readFile: async (p) => (p === "package.json" ? "manifest" : undefined) });
    expect(tc.tools).toEqual([expect.objectContaining({ tool: "node", range: "20", source: ".nvmrc" })]);
    expect(tc.notes).toEqual(["node: .nvmrc asks for 20 and api/.nvmrc for 22; using 20"]);
  });

  it("keeps the other parts' versions when one part's detection throws", async () => {
    const web = config();
    const twoParts = { ...web, parts: { ...web.parts, api: { ...web.parts.web!, path: "api", profile: "service" } } };
    const broken: Profile = { ...stubProfile("service", []), toolchain: async () => Promise.reject(new Error("bad")) };
    const tc = await profileToolchain([withToolchain("web-app", "20"), broken], twoParts)!({ files: ["package.json"], readFile: async () => "manifest" });
    expect(tc.tools.map((t) => t.range)).toEqual(["20"]);
    expect(tc.notes).toEqual(["parts.api: its tool versions couldn't be read; none required for it"]);
  });
});
