// The `web-app` profile (docs/PROFILES.md §4.1), v0: detect, skill, verify, guidance and the preview contract.
// Previews are built in P1-11; evaluated guardrails arrive in Phase 2.
import type { EnvironmentSpec, Profile } from "@globalhost/core";
import { webAppConfigSchema, type WebAppConfig } from "./config.js";
import { detectWebApp, type WebAppDetection } from "./detect.js";
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
export { SESSION_OUTPUTS, webAppGuidance } from "./guidance.js";
export { installCommand, SCREENSHOT_DIR, smokeEnv, VERIFY_STEP_IDS, verifySteps } from "./verify.js";

/** Agent runs on web-app parts reach package registries only (ADR-0011 `limited` networking). */
export const webAppEnvironment: EnvironmentSpec = { name: "globalhost-web-app", allowedHosts: [] };

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
    // Env files hold real values; agents never write them (skills/web-app). Example files are owner-edited too.
    immutable: [".env", ".env.*"],
    checks: [],
  },
};
