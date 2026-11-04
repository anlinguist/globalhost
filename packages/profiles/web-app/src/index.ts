// The `web-app` profile (docs/PROFILES.md §4.1), v0: detect, skill, verify, guidance and the preview contract.
// Previews are built in P1-11. Evaluated guardrails: dependency-change (shared) and visual-baseline (P2-03).
import type { EnvironmentSpec, Profile, RepoSnapshot, Toolchain } from "@globalhost/core";
import { dependencyChange, detectBun, detectNode, joinToolchains } from "@globalhost/profile-toolchains";
import { webAppConfigSchema, type WebAppConfig } from "./config.js";
import { detectWebApp, type WebAppDetection } from "./detect.js";
import { visualBaseline } from "./guardrails.js";
import { webAppGuidance } from "./guidance.js";
import { verifySteps } from "./verify.js";

export { webAppConfigSchema, type WebAppConfig } from "./config.js";
export {
  detectWebApp,
  FRAMEWORKS,
  KNOWN_SCRIPTS,
  PACKAGE_MANAGERS,
  type Framework,
  type KnownScript,
  type PackageManager,
  type WebAppDetection,
} from "./detect.js";
export { VISUAL_BASELINE_GLOBS, visualBaseline } from "./guardrails.js";
export { SESSION_OUTPUTS, webAppGuidance } from "./guidance.js";
export { installCommand, SCREENSHOT_DIR, smokeEnv, VERIFY_STEP_IDS, verifySteps } from "./verify.js";

/** Agent runs on web-app parts reach package registries only (ADR-0011 `limited` networking). */
export const webAppEnvironment: EnvironmentSpec = { name: "globalhost-web-app", allowedHosts: [] };

/**
 * Node's version for the part (and Bun's, when the part uses Bun), from the snapshot the caller gives: the run's
 * base commit. Precedence and parsing live in @globalhost/profile-toolchains.
 */
export async function webAppToolchain(repo: RepoSnapshot, part: { name: string; path: string }): Promise<Toolchain> {
  const node = await detectNode(repo, part.path);
  const { packageManager } = await detectWebApp(repo, part.path);
  return packageManager === "bun" ? joinToolchains(node, await detectBun(repo, part.path)) : joinToolchains(node);
}

const previewNotYet = (): Promise<never> => Promise.reject(new Error("web-app previews are not implemented yet (P1-11)"));

export const webApp: Profile<WebAppConfig, WebAppDetection> = {
  id: "web-app",
  version: "0.1.0",
  configSchema: webAppConfigSchema,
  detect: detectWebApp,
  scaffold: { install: [] },
  skills: [{ name: "web-app", path: "skills/web-app" }],
  environment: webAppEnvironment,
  guidance: webAppGuidance,
  toolchain: webAppToolchain,
  verify: {
    steps: verifySteps,
    localSubset: ["install", "typecheck", "lint", "test", "build", "smoke"],
  },
  preview: {
    kinds: ["url", "screenshots"],
    outputs: ["url"],
    inputs: [],
    build: previewNotYet,
    teardown: previewNotYet,
  },
  release: {
    defaultAdapter: "cloud-build-trigger",
    allowedAdapters: ["cloud-build-trigger"],
  },
  guardrails: {
    // Env files hold real values; agents never write them, at any depth in the part (skills/web-app). That includes
    // `.env.example`, which the owner adds: there's deliberately no carve-out. `.env.d/` is a directory of the same files.
    immutable: ["**/.env", "**/.env.*", "**/.envrc", "**/.env.d/**"],
    checks: [dependencyChange, visualBaseline],
  },
};
