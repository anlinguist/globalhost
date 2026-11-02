// Pulumi entry point (Pulumi.yaml `main: dist/src/index.js`). Run `pnpm build` before `pulumi up`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as pulumi from "@pulumi/pulumi";
import { CloudflareConfigSchema, parseFactoryConfig } from "./config.js";
import { createFactory, type FunctionSource } from "./factory.js";

// dist/src/index.js → project root (infra/factory)
const root = fileURLToPath(new URL("../../", import.meta.url));

/** Compiled function code + its deploy manifest and lockfile (Cloud Build runs `npm ci` on them). */
function budgetPauseSource(): FunctionSource {
  const files: Record<string, string> = {
    "index.js": `${root}dist/functions/budget-pause/index.js`,
    "pause.js": `${root}dist/functions/budget-pause/pause.js`,
    "package.json": `${root}functions/budget-pause/deploy/package.json`,
    "package-lock.json": `${root}functions/budget-pause/deploy/package-lock.json`,
  };
  const hash = createHash("sha256");
  const assets: Record<string, pulumi.asset.Asset> = {};
  for (const [name, path] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update("\0").update(readFileSync(path)).update("\0");
    assets[name] = new pulumi.asset.FileAsset(path);
  }
  return { archive: new pulumi.asset.AssetArchive(assets), hash: hash.digest("hex").slice(0, 16) };
}

/** Built by `pnpm build` (turbo builds the router first); fails loudly if missing rather than deploying nothing. */
const routerScript = readFileSync(`${root}../../packages/preview-router/dist/index.js`, "utf8");

const gcpConfig = new pulumi.Config("gcp");
const cfg = new pulumi.Config();
const config = parseFactoryConfig({
  project: gcpConfig.require("project"),
  region: gcpConfig.require("region"),
  githubOwnerId: cfg.require("githubOwnerId"),
  dispatchRepos: cfg.requireObject("dispatchRepos"),
  ...(cfg.get("dispatchEnvironment") ? { dispatchEnvironment: cfg.get("dispatchEnvironment") } : {}),
  ...(cfg.getNumber("monthlyBudgetUsd") ? { monthlyBudgetUsd: cfg.getNumber("monthlyBudgetUsd") } : {}),
  factoryRepoId: cfg.require("factoryRepoId"),
  previews: cfg.getObject("previews") ?? [],
  releaseObservers: cfg.getObject("releaseObservers") ?? [],
  previewActorIds: cfg.getObject("previewActorIds") ?? [],
  ...(cfg.get("accessGuardImage") ? { accessGuardImage: cfg.get("accessGuardImage") } : {}),
});
// Account/zone IDs and the owner's email stay out of the public repo: a secret object, validated here.
const cloudflare = cfg.getSecretObject<unknown>("cloudflare")?.apply((v) => CloudflareConfigSchema.parse(v));

const out = createFactory({
  config,
  billingAccount: cfg.requireSecret("billingAccount"),
  budgetPauseSource: budgetPauseSource(),
  factoryRepoName: cfg.require("factoryRepoName"),
  routerScript,
  ...(cloudflare ? { cloudflare } : {}),
});

export const projectNumber = out.projectNumber;
export const runsBucket = out.runsBucket;
export const controlBucket = out.controlBucket;
export const controlStateObject = out.controlStateObject;
export const ghDispatchServiceAccount = out.ghDispatchServiceAccount;
export const workloadIdentityProvider = out.workloadIdentityProvider;
export const githubAppKeySecret = out.githubAppKeySecret;
export const budgetTopic = out.budgetTopic;
export const budgetPauseFunction = out.budgetPauseFunction;
export const imagesRepository = out.imagesRepository;
export const imagePublisherServiceAccount = out.imagePublisherServiceAccount;
export const imagesWorkloadIdentityProvider = out.imagesWorkloadIdentityProvider;
export const previews = out.previews;
export const releaseObservers = out.releaseObservers;
