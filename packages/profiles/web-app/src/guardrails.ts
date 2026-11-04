// web-app's own guardrail. dependency-change is shared (@globalhost/profile-toolchains).
import type { Guardrail } from "@globalhost/core";

/**
 * Where the common visual-regression tools keep baseline images by default: Playwright (`<spec>-snapshots/`), Vitest
 * browser mode (`__screenshots__/`), jest-image-snapshot (`__image_snapshots__/`) and Cypress plugins
 * (`cypress/snapshots/`). Not `__snapshots__/`: those are text snapshots, which a builder updates along with the code,
 * and which show up as readable lines in the diff. A baseline image is the opposite: it can't be read in a diff, and
 * regenerating one makes a failing visual check pass.
 */
export const VISUAL_BASELINE_GLOBS: readonly string[] = Object.freeze([
  "**/*-snapshots/**",
  "**/__screenshots__/**",
  "**/__image_snapshots__/**",
  "**/cypress/snapshots/**",
]);

/** Any change under a baseline path needs the owner to look. The engine only calls this when one matched. */
export const visualBaseline: Guardrail = {
  id: "visual-baseline",
  paths: [...VISUAL_BASELINE_GLOBS],
  approvalLabel: "approved:visual",
  evaluate: () => Promise.resolve({ kind: "needsApproval", reason: "visual baseline files changed" }),
};
