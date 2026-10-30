import type { PartCtx } from "@globalhost/core";
import type { WebAppConfig } from "./config.js";
import type { Framework, WebAppDetection } from "./detect.js";
import { SCREENSHOT_DIR, verifySteps } from "./verify.js";

/** Where agent runs put files for the publisher to collect (ADR-0011). */
export const SESSION_OUTPUTS = "/mnt/session/outputs";

const FRAMEWORK_LABEL: Record<Framework, string> = {
  next: "Next.js",
  remix: "Remix",
  "react-router": "React Router (framework mode)",
  astro: "Astro",
  nuxt: "Nuxt",
  sveltekit: "SvelteKit",
  angular: "Angular",
  vite: "Vite",
  "create-react-app": "Create React App",
  static: "static HTML",
  none: "unrecognized",
};

function shellEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${/^[A-Za-z0-9._/:,@+-]*$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`}`)
    .join(" ");
}

/**
 * The web-app section of a run's task message. Built from the part's factory.yaml entry (owner-authored) and
 * detection fields drawn from fixed sets, never from repo text, so it is safe to place in the trusted part of
 * the prompt. The skill (skills/web-app) carries the general how-to; this carries the repo-specific commands.
 */
export function webAppGuidance(part: PartCtx<WebAppConfig, WebAppDetection>): string {
  const { config, detection } = part;
  const steps = verifySteps(part);
  const where = part.path === "." ? "the repo root" : `\`${part.path}/\``;
  const lines = [
    `## Part \`${part.name}\` (web-app)`,
    "",
    `A ${FRAMEWORK_LABEL[detection.framework]} web app at ${where}, using ${detection.packageManager}. Follow the web-app skill. Run every command from ${where}.`,
    "",
    "Before you finish, run these in order and fix what fails (environment shown before each command where it matters):",
    "",
    ...steps.map((s) => `- ${s.id}: \`${s.env && Object.keys(s.env).length > 0 ? `${shellEnv(s.env)} ` : ""}${s.run}\``),
    "",
  ];
  if (config.install !== undefined) {
    lines.push("Install with the command above exactly; the owner set it in factory.yaml because the default lockfile install fails for this repo.", "");
  }
  if (Object.keys(config.previewEnv).length > 0) {
    lines.push(
      "The build and smoke test need the non-secret preview environment shown on those steps; the app may fail at runtime without it. Don't write it to a file in the repo.",
      "",
    );
  }
  lines.push(
    `The smoke test is a Playwright test that starts the built app on port ${config.port}, visits each route in GLOBALHOST_ROUTES (${config.routes.map((r) => `\`${r}\``).join(", ")}) at desktop and mobile viewports, checks each loads without a server error or uncaught page error, and saves a full-page screenshot per route and viewport to GLOBALHOST_SCREENSHOT_DIR. If the repo has no smoke test yet, add one.`,
    `In this session, run it with GLOBALHOST_SCREENSHOT_DIR=${SESSION_OUTPUTS}/screenshots so the screenshots reach the PR (CI uses \`${SCREENSHOT_DIR}/\`). Don't commit screenshots or Playwright reports.`,
  );
  if (!detection.playwright) lines.push("Playwright isn't a dependency yet: add `@playwright/test` as a dev dependency and a `playwright.config` with a `webServer` that starts the built app.");
  return `${lines.join("\n")}\n`;
}
