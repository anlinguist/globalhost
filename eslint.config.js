// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Non-negotiable #1: packages/core stays profile- and adapter-agnostic.
// Exported so packages/core/test/import-boundary.test.ts can assert on the same patterns.
export const CORE_FORBIDDEN_IMPORTS = [
  "@globalhost/profile-*",
  "@globalhost/adapter-*",
  "**/profiles/**",
  "**/adapters/**",
];
const CORE_BOUNDARY_MESSAGE =
  "packages/core must not depend on profiles or adapters. Put type-specific behavior in a profile or adapter (CLAUDE.md non-negotiable #1).";
// no-restricted-imports doesn't see dynamic import(), so match those literals separately.
const FORBIDDEN_DYNAMIC_SOURCE = "/^@globalhost\\/(profile|adapter)-|(^|\\/)(profiles|adapters)\\//";

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/", "**/.turbo/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: CORE_FORBIDDEN_IMPORTS, message: CORE_BOUNDARY_MESSAGE }] },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression[source.value=${FORBIDDEN_DYNAMIC_SOURCE}]`,
          message: CORE_BOUNDARY_MESSAGE,
        },
      ],
    },
  },
);
