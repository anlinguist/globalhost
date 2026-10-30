import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FACTORY_YAML_ERROR_CODES, parseFactoryYaml, validateFactoryConfig, type FactoryYamlError } from "../src/index.js";
import { generatedInvalid } from "./fixtures/factory-yaml/generated.js";
import { fakeRegistry } from "./fixtures/factory-yaml/registry.js";

// Fixture layout (packages/core/test/fixtures/factory-yaml/):
//   valid/<name>.yaml    + valid/<name>.json: the normalized config it must produce (regenerate: pnpm test -u)
//   invalid/<name>.yaml  with `# expect: <path> <code>` header lines (`<root>` for ""), the exact sorted error list
const FIXTURES = new URL("./fixtures/factory-yaml/", import.meta.url);
const list = (sub: string, ext: string) =>
  readdirSync(new URL(sub, FIXTURES))
    .filter((f) => f.endsWith(ext))
    .sort();

function check(bytes: Uint8Array): { ok: true; config: unknown } | { ok: false; errors: FactoryYamlError[] } {
  const parsed = parseFactoryYaml(bytes);
  if (!parsed.ok) return parsed;
  return validateFactoryConfig(parsed.value, fakeRegistry);
}

const validFiles = list("valid/", ".yaml");
const invalidFiles = list("invalid/", ".yaml");

describe("valid factory.yaml fixtures", () => {
  it("has at least 10", () => expect(validFiles.length).toBeGreaterThanOrEqual(10));

  it.each(validFiles)("%s normalizes as recorded", async (file) => {
    const result = check(readFileSync(new URL(`valid/${file}`, FIXTURES)));
    if (!result.ok) expect.fail(JSON.stringify(result.errors, null, 2));
    await expect(`${JSON.stringify(result.config, null, 2)}\n`).toMatchFileSnapshot(
      `./fixtures/factory-yaml/valid/${file.replace(/\.yaml$/, ".json")}`,
    );
  });
});

function expectations(text: string): Array<{ path: string; code: string }> {
  return [...text.matchAll(/^# expect: (\S+) (\S+)$/gm)].map(([, path = "", code = ""]) => ({
    path: path === "<root>" ? "" : path,
    code,
  }));
}

const coveredCodes = new Set<string>();

describe("invalid factory.yaml fixtures", () => {
  it("has at least 25", () => expect(invalidFiles.length).toBeGreaterThanOrEqual(25));

  it.each(invalidFiles)("%s reports exactly its expected errors", (file) => {
    const bytes = readFileSync(new URL(`invalid/${file}`, FIXTURES));
    const expected = expectations(bytes.toString("utf8"));
    expect(expected.length, "fixture needs `# expect:` lines").toBeGreaterThan(0);
    const result = check(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual(expected);
    for (const e of result.errors) {
      coveredCodes.add(e.code);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it.each(generatedInvalid.map((f) => [f.name, f] as const))("generated: %s", (_name, fixture) => {
    const result = check(fixture.bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual(fixture.expected);
    for (const e of result.errors) coveredCodes.add(e.code);
  });

  // Runs after the fixtures above (vitest runs tests in a file sequentially, in order).
  it("together cover every error code in FACTORY-YAML §5", () => {
    expect([...FACTORY_YAML_ERROR_CODES].filter((c) => !coveredCodes.has(c))).toEqual([]);
  });
});
