import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRegistry,
  FACTORY_SCHEMA_ID,
  factoryJsonSchema,
  formatPath,
  IMMUTABLE_BASELINE,
  parseFactoryYaml,
  validateFactoryConfig,
  type ProfileDescriptor,
} from "../src/index.js";
import { fakeDeploy, fakeExt, fakeRegistry, fakeWeb } from "./fixtures/factory-yaml/registry.js";

const base = (parts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  version: 1,
  product: "sample",
  owners: [{ login: "octo-owner", id: 1001 }],
  parts,
  ...extra,
});

describe("formatPath", () => {
  it("dots identifiers, brackets indexes, and JSON-quotes other keys", () => {
    expect(formatPath(["parts", "web", "dependsOn", 0])).toBe("parts.web.dependsOn[0]");
    expect(formatPath(["parts", "Web-App", "path"])).toBe('parts["Web-App"].path');
    expect(formatPath(["guardrails", "x\u001by"])).toBe('guardrails["x\\u001by"]');
    expect(formatPath([])).toBe("");
  });
});

describe("validateFactoryConfig", () => {
  it("is deterministic: the same input gives the same output", () => {
    const input = base({ b: { path: "b", profile: "nope" }, a: { path: "a", profile: "nope" } });
    expect(validateFactoryConfig(input, fakeRegistry)).toEqual(validateFactoryConfig(structuredClone(input), fakeRegistry));
  });

  it("doesn't run stage 2 while the shape is wrong", () => {
    const result = validateFactoryConfig(base({ app: { path: "/abs", profile: "unregistered" } }), fakeRegistry);
    expect(result).toMatchObject({ ok: false, errors: [{ path: "parts.app.path", code: "invalid_value" }] });
    if (!result.ok) expect(result.errors).toHaveLength(1);
  });

  it("reports every stage-2 error, sorted by path then code", () => {
    const result = validateFactoryConfig(
      base(
        { z: { path: "z", profile: "missing" }, a: { path: "a", profile: "fake-ext", dependsOn: ["a"] } },
        { autonomy: "L0", autoMerge: ["lint-fix"], limits: { perRunUsd: 30 } },
      ),
      fakeRegistry,
    );
    expect(result.ok ? [] : result.errors.map((e) => `${e.path} ${e.code}`)).toEqual([
      "autoMerge automerge_requires_l3",
      "limits.perRunUsd limits_inconsistent",
      "parts.a.dependsOn[0] dependency_self",
      "parts.z.profile unknown_profile",
    ]);
  });

  it("validates with an empty registry, failing any part with unknown_profile", () => {
    const result = validateFactoryConfig(base({ app: { path: ".", profile: "fake-ext" } }), createRegistry([], []));
    expect(result).toMatchObject({ ok: false, errors: [{ path: "parts.app.profile", code: "unknown_profile" }] });
  });

  it("can't remove the immutable baseline", () => {
    const result = validateFactoryConfig(
      base({ app: { path: ".", profile: "fake-ext" } }, { guardrails: { immutable: [] } }),
      fakeRegistry,
    );
    expect(result.ok && result.config.guardrails.immutable).toEqual([...IMMUTABLE_BASELINE]);
  });

  it("returns fresh default objects (no state shared between results)", () => {
    const input = base({ app: { path: ".", profile: "fake-ext" } });
    const a = validateFactoryConfig(input, fakeRegistry);
    const b = validateFactoryConfig(input, fakeRegistry);
    if (!a.ok || !b.ok) return expect.fail("expected valid");
    a.config.autoMerge.push("lint-fix");
    a.config.parts.app!.dependsOn.push("x");
    expect(b.config.autoMerge).toEqual([]);
    expect(b.config.parts.app!.dependsOn).toEqual([]);
  });

  it("passes the profile schema the raw config, so a __proto__ key can't hide from a closed schema", () => {
    const parsed = parseFactoryYaml(`version: 1
product: sample
owners: [{ login: octo-owner, id: 1001 }]
environments: { dev: { gcpProject: sample-dev, region: us-central1 } }
parts:
  web: { path: ., profile: fake-web, config: { __proto__: { port: 1 } } }
`);
    if (!parsed.ok) return expect.fail("parse failed");
    const result = validateFactoryConfig(parsed.value, fakeRegistry);
    expect(result).toMatchObject({ ok: false, errors: [{ path: "parts.web.config.__proto__", code: "profile_config" }] });
  });

  it("reports a profile schema that throws or is async, instead of throwing", () => {
    const throwing: ProfileDescriptor = {
      ...fakeExt,
      id: "throwing",
      configSchema: z.object({}).transform(() => {
        throw new Error("boom");
      }),
    };
    const asyncProfile: ProfileDescriptor = { ...fakeExt, id: "async", configSchema: z.object({}).refine(async () => true) };
    const registry = createRegistry([throwing, asyncProfile], []);
    const result = validateFactoryConfig(
      base({ a: { path: "a", profile: "throwing" }, b: { path: "b", profile: "async" } }),
      registry,
    );
    expect(result.ok ? [] : result.errors.map((e) => `${e.path} ${e.code}`)).toEqual([
      "parts.a.config profile_config",
      "parts.b.config profile_config",
    ]);
  });

  it("quotes at most 80 characters of a value from the file", () => {
    const long = `${"x".repeat(500)}`;
    const result = validateFactoryConfig(base({ app: { path: ".", profile: "fake-ext" } }, { product: long, [long]: 1 }), fakeRegistry);
    if (result.ok) return expect.fail("expected errors");
    for (const e of result.errors) {
      expect(e.message).not.toContain("x".repeat(81));
      expect(e.path.length).toBeLessThan(600); // paths name keys in full; only messages are truncated
    }
    expect(result.errors.map((e) => e.code).sort()).toEqual(["invalid_value", "unknown_key"]);
  });

  it("rejects a binding that names its own part through dependsOn only once", () => {
    const result = validateFactoryConfig(
      base(
        { web: { path: ".", profile: "fake-web", dependsOn: ["web"], preview: { bindings: { API_URL: "${parts.web.preview.url}" } } } },
        { environments: { dev: { gcpProject: "sample-dev", region: "us-central1" } } },
      ),
      fakeRegistry,
    );
    expect(result.ok ? [] : result.errors.map((e) => `${e.path} ${e.code}`)).toEqual(["parts.web.dependsOn[0] dependency_self"]);
  });

  it("names the cycle in its message", () => {
    const result = validateFactoryConfig(
      base({
        web: { path: "w", profile: "fake-ext", dependsOn: ["api"] },
        api: { path: "a", profile: "fake-ext", dependsOn: ["web"] },
      }),
      fakeRegistry,
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [{ path: "parts.api.dependsOn", code: "dependency_cycle", message: "dependency cycle: api → web → api" }],
    });
  });

  it("explains branchPrefix instead of calling it an unknown key", () => {
    const result = validateFactoryConfig(base({ app: { path: ".", profile: "fake-ext" } }, { git: { branchPrefix: "x/" } }), fakeRegistry);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "branch_prefix_fixed", message: expect.stringContaining("factory/") }] });
  });
});

describe("createRegistry", () => {
  it("rejects duplicate ids", () => {
    expect(() => createRegistry([fakeWeb, fakeWeb], [])).toThrow(/duplicate profile id "fake-web"/);
    expect(() => createRegistry([], [fakeDeploy, fakeDeploy])).toThrow(/duplicate adapter id "fake-deploy"/);
  });

  it.each(["Web", "-web", "web_app", "", "a".repeat(41), "__proto__"])("rejects the id %j", (id) => {
    expect(() => createRegistry([{ ...fakeWeb, id }], [])).toThrow(/must match/);
    expect(() => createRegistry([], [{ ...fakeDeploy, id }])).toThrow(/must match/);
  });

  it("rejects malformed preview inputs and outputs", () => {
    expect(() => createRegistry([{ ...fakeWeb, preview: { ...fakeWeb.preview, inputs: ["NODE OPTIONS"] } }], [])).toThrow(/preview input/);
    expect(() => createRegistry([{ ...fakeWeb, preview: { ...fakeWeb.preview, outputs: ["a.b"] } }], [])).toThrow(/preview output/);
  });

  it("looks up only registered ids, never inherited properties", () => {
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(fakeRegistry.profile(id)).toBeUndefined();
      expect(fakeRegistry.adapter(id)).toBeUndefined();
    }
    expect(fakeRegistry.profile("fake-web")).toBe(fakeWeb);
  });
});

describe("schemas/factory.schema.json", () => {
  it("matches the schema generated from zod (regenerate: pnpm schema:update)", async () => {
    await expect(`${JSON.stringify(factoryJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../../../schemas/factory.schema.json");
  });

  it("is draft 2020-12 with the published $id, closed at the top level", () => {
    const schema = factoryJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(FACTORY_SCHEMA_ID);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["version", "product", "owners", "parts"]);
  });
});
