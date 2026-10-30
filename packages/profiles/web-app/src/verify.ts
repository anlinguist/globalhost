import type { PartCtx, VerifyStep } from "@globalhost/core";
import type { WebAppConfig } from "./config.js";
import type { PackageManager, WebAppDetection } from "./detect.js";

/** Step ids in run order. Steps whose script the repo lacks are left out. */
export const VERIFY_STEP_IDS = ["install", "typecheck", "lint", "test", "build", "smoke"] as const;

/** Part-relative directory the smoke test writes screenshots to (env GLOBALHOST_SCREENSHOT_DIR). */
export const SCREENSHOT_DIR = "screenshots";

const INSTALL: Record<PackageManager, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
};

/** Runs a binary from node_modules/.bin without downloading anything. */
const EXEC: Record<PackageManager, string> = {
  npm: "npx --no-install",
  pnpm: "pnpm exec",
  yarn: "yarn",
  bun: "bun run",
};

export function installCommand(part: PartCtx<WebAppConfig, WebAppDetection>): string {
  return part.config.install ?? INSTALL[part.detection.packageManager];
}

export function runScript(pm: PackageManager, script: string): string {
  return `${pm} run ${script}`;
}

/** The smoke step's environment: previewEnv plus the port, routes and screenshot directory the test reads. */
export function smokeEnv(config: WebAppConfig): Record<string, string> {
  return {
    ...config.previewEnv,
    PORT: String(config.port),
    GLOBALHOST_ROUTES: config.routes.join(","),
    GLOBALHOST_SCREENSHOT_DIR: SCREENSHOT_DIR,
  };
}

export function verifySteps(part: PartCtx<WebAppConfig, WebAppDetection>): VerifyStep[] {
  const { config, detection } = part;
  const pm = detection.packageManager;
  const steps: VerifyStep[] = [{ id: "install", run: installCommand(part) }];
  const after = ["install"];

  if (detection.scripts.typecheck) steps.push({ id: "typecheck", run: runScript(pm, "typecheck"), needs: after });
  else if (detection.typescript) steps.push({ id: "typecheck", run: `${EXEC[pm]} tsc --noEmit`, needs: after });
  if (detection.scripts.lint) steps.push({ id: "lint", run: runScript(pm, "lint"), needs: after });
  if (detection.scripts.test) steps.push({ id: "test", run: runScript(pm, "test"), needs: after });
  if (detection.scripts.build) {
    steps.push({ id: "build", run: runScript(pm, "build"), needs: after, env: { ...config.previewEnv } });
  }
  // Always present, so a repo without a smoke test fails closed until one is written (skills/web-app).
  steps.push({
    id: "smoke",
    run: `${EXEC[pm]} playwright test`,
    needs: detection.scripts.build ? ["build"] : after,
    env: smokeEnv(config),
    artifacts: ["playwright-report", "test-results", SCREENSHOT_DIR],
  });
  return steps;
}
