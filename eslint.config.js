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
// Specifiers lint can't read statically (template literals, variables) and require() via createRequire
// could load anything, so core may not use them at all.
const UNCHECKABLE_LOAD_MESSAGE =
  "packages/core may only load modules with a static string specifier, so the profile/adapter boundary stays checkable (CLAUDE.md non-negotiable #1).";

export default tseslint.config(
  // skills/security-audit is vendored upstream code (ADR-0012), kept byte-for-byte.
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/", "**/.turbo/", "skills/security-audit/", "spikes/**/.out/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
  },
  {
    files: ["packages/core/**"],
    // An inline eslint-disable could switch the boundary off; core gets no inline config at all.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
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
        { selector: "ImportExpression[source.type!='Literal']", message: UNCHECKABLE_LOAD_MESSAGE },
        { selector: "CallExpression[callee.name='createRequire']", message: UNCHECKABLE_LOAD_MESSAGE },
        { selector: "CallExpression[callee.property.name='createRequire']", message: UNCHECKABLE_LOAD_MESSAGE },
        { selector: "CallExpression[callee.name='require']", message: UNCHECKABLE_LOAD_MESSAGE },
      ],
    },
  },
);
