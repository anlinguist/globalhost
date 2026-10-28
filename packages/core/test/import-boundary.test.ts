import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Lints fixture snippets with the repo's real eslint.config.js, as if they lived at the given path.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function boundaryErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${filePath}` });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

const CORE_FILE = "packages/core/src/fixture.ts";

describe("packages/core import boundary (CLAUDE.md non-negotiable #1)", () => {
  it.each([
    ["a profile package", `import { webApp } from "@globalhost/profile-web-app";\nexport { webApp };`],
    ["an adapter package", `import { adapter } from "@globalhost/adapter-cloud-build-trigger";\nexport { adapter };`],
    ["a profile subpath", `import { detect } from "@globalhost/profile-web-app/detect";\nexport { detect };`],
    ["a relative path into profiles", `import { webApp } from "../../profiles/web-app/src/index.js";\nexport { webApp };`],
    ["a relative path into adapters", `import { a } from "../../adapters/cloud-run/src/index.js";\nexport { a };`],
    ["a type-only import", `import type { Profile } from "@globalhost/profile-web-app";\nexport type { Profile };`],
    ["a re-export", `export { webApp } from "@globalhost/profile-web-app";`],
    ["a star re-export", `export * from "../../adapters/cloud-run/src/index.js";`],
    ["a dynamic import", `export const load = () => import("@globalhost/profile-web-app");`],
    ["a dynamic relative import", `export const load = () => import("../../profiles/web-app/src/index.js");`],
  ])("rejects %s", async (_name, code) => {
    const errors = await boundaryErrors(code, CORE_FILE);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must not depend on profiles or adapters");
  });

  it("applies to core tests too, not just src", async () => {
    const errors = await boundaryErrors(`import "@globalhost/profile-web-app";`, "packages/core/test/fixture.test.ts");
    expect(errors).toHaveLength(1);
  });

  it.each([
    ["node builtins", `import { readFileSync } from "node:fs";\nexport { readFileSync };`],
    ["a third-party package", `import { z } from "zod";\nexport { z };`],
    ["a sibling core module", `import { x } from "./schema.js";\nexport { x };`],
    ["a name that merely contains 'profile'", `import { x } from "./profiles-schema.js";\nexport { x };`],
  ])("allows %s", async (_name, code) => {
    expect(await boundaryErrors(code, CORE_FILE)).toEqual([]);
  });

  it("does not restrict other packages from importing profiles", async () => {
    const code = `import { webApp } from "@globalhost/profile-web-app";\nexport { webApp };`;
    expect(await boundaryErrors(code, "packages/cli/src/fixture.ts")).toEqual([]);
  });
});
