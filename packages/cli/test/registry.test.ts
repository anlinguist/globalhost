import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudBuildTrigger } from "@globalhost/adapter-cloud-build-trigger";
import {
  createRegistry,
  parseFactoryYaml,
  validateFactoryConfig,
  z,
  type DeployAdapter,
  type Detection,
  type Profile,
  type RepoSnapshot,
} from "@globalhost/core";
import { webApp } from "@globalhost/profile-web-app";
import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";

// "Adding a profile = adding a package + registering its id. No core change." (PROFILES.md §1)
// This file plays the new package: a `static-site` profile and a `bucket-upload` adapter written against
// core's public exports only, registered next to the real ones.

const staticSiteConfig = z.strictObject({ outDir: z.string().default("dist") });
type StaticSiteConfig = z.output<typeof staticSiteConfig>;

const staticSite: Profile<StaticSiteConfig> = {
  id: "static-site",
  version: "0.0.1",
  configSchema: staticSiteConfig,
  async detect(repo: RepoSnapshot, path: string): Promise<Detection<StaticSiteConfig>> {
    const html = repo.files.includes(path === "." ? "index.html" : `${path}/index.html`);
    return { confidence: html ? 0.6 : 0, evidence: html ? ["index.html"] : [], suggestedConfig: { outDir: "." } };
  },
  scaffold: { install: [] },
  skills: [],
  environment: { name: "globalhost-static-site", allowedHosts: [] },
  guidance: (part) => `Static site in ${part.path}; output in ${part.config.outDir}.`,
  verify: { steps: () => [{ id: "build", run: "make" }], localSubset: ["build"] },
  preview: {
    kinds: ["url"],
    outputs: ["url"],
    inputs: ["API_URL"],
    build: async () => ({ outputs: { url: "https://example.invalid" }, artifacts: [] }),
    teardown: async () => {},
  },
  release: { defaultAdapter: "bucket-upload", allowedAdapters: ["bucket-upload"] },
  guardrails: { immutable: [], checks: [] },
};

const bucketUploadConfig = z.strictObject({ bucket: z.string().min(3) });
const bucketUpload: DeployAdapter<z.output<typeof bucketUploadConfig>> = {
  id: "bucket-upload",
  configSchema: bucketUploadConfig,
  capabilities: { preview: false, canary: false, rollback: false, asyncGate: false },
  release: async (ctx) => ({ adapter: "bucket-upload", sha: ctx.sha, data: {} }),
  status: async () => ({ state: "succeeded", detail: "uploaded" }),
};

const YAML = `version: 1
product: sample
owners:
  - { login: octo-owner, id: 1001 }
environments:
  dev: { gcpProject: sample-dev, region: us-central1 }
parts:
  web:
    path: apps/web
    profile: web-app
    config: { routes: ["/"] }
    release:
      - adapter: cloud-build-trigger
        config: { project: sample-prod, trigger: deploy-main }
  site:
    path: apps/site
    profile: static-site
    dependsOn: [web]
    config: { outDir: public }
    preview:
      bindings: { API_URL: "\${parts.web.preview.url}" }
    release:
      - adapter: bucket-upload
        config: { bucket: sample-site }
`;

describe("profile registry", () => {
  const registry = createRegistry<Profile, DeployAdapter>([webApp, staticSite], [cloudBuildTrigger, bucketUpload]);

  it("validates a factory.yaml using a profile and adapter that core has never heard of", () => {
    const parsed = parseFactoryYaml(new TextEncoder().encode(YAML));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const result = validateFactoryConfig(parsed.value, registry);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.config.parts.site?.config).toEqual({ outDir: "public" });
  });

  it("runs the new profile's and adapter's config schemas", () => {
    const bad = YAML.replace("outDir: public", "outDir: 1").replace("bucket: sample-site", "bucket: x");
    const parsed = parseFactoryYaml(new TextEncoder().encode(bad));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const result = validateFactoryConfig(parsed.value, registry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.path, e.code])).toEqual([
      ["parts.site.config.outDir", "profile_config"],
      ["parts.site.release[0].config.bucket", "adapter_config"],
    ]);
  });

  it("hands registered profiles back fully typed, so the runner can call detect/guidance", async () => {
    const profile = registry.profile("static-site");
    expect(profile?.guidance({ name: "site", path: "apps/site", config: { outDir: "public" }, detection: await profile.detect({ files: [], readFile: async () => undefined }, ".") })).toBe(
      "Static site in apps/site; output in public.",
    );
    expect(registry.profiles().map((p) => p.id)).toEqual(["web-app", "static-site"]);
    expect(registry.adapters().map((a) => a.id)).toEqual(["cloud-build-trigger", "bucket-upload"]);
  });

  it("works through the CLI with an injected registry", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "globalhost-registry-"));
    try {
      const path = join(dir, "factory.yaml");
      fs.writeFileSync(path, YAML);
      expect(run(["validate", path], { registry })).toMatchObject({ code: 0 });
      // The default registry doesn't know static-site: registering it is the only change needed.
      expect(JSON.parse(run(["validate", path, "--json"]).stdout)).toMatchObject({
        ok: false,
        errors: [
          { path: "parts.site.profile", code: "unknown_profile" },
          { path: "parts.site.release[0].adapter", code: "unknown_adapter" },
        ],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
