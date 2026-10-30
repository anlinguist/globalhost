import { describe, expect, it } from "vitest";
import { MAX_FACTORY_YAML_BYTES, MAX_FACTORY_YAML_DEPTH, parseFactoryYaml } from "../src/index.js";
import { paddedTo } from "./fixtures/factory-yaml/generated.js";

const nested = (n: number) => `x: ${"[".repeat(n - 1)}${"]".repeat(n - 1)}\n`;

describe("parseFactoryYaml", () => {
  it("keeps a __proto__ key as an own data property and never changes a prototype", () => {
    const result = parseFactoryYaml("__proto__: { polluted: true }\nnested: { __proto__: { polluted: true } }\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Record<string, Record<string, unknown>>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ polluted: true });
    expect(Object.hasOwn(value.nested!, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((value as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("uses the YAML 1.2 core schema, even under a %YAML 1.1 directive", () => {
    for (const text of ["a: yes\nb: on\nc: no\nd: off\ne: y\n", "%YAML 1.1\n---\na: yes\nb: on\nc: no\nd: off\ne: y\n"]) {
      expect(parseFactoryYaml(text)).toEqual({ ok: true, value: { a: "yes", b: "on", c: "no", d: "off", e: "y" } });
    }
  });

  it("treats << as an ordinary key", () => {
    expect(parseFactoryYaml("<<: { a: 1 }\n")).toEqual({ ok: true, value: { "<<": { a: 1 } } });
  });

  it(`accepts nesting of exactly ${MAX_FACTORY_YAML_DEPTH} and rejects ${MAX_FACTORY_YAML_DEPTH + 1}`, () => {
    expect(parseFactoryYaml(nested(MAX_FACTORY_YAML_DEPTH)).ok).toBe(true);
    const deep = parseFactoryYaml(nested(MAX_FACTORY_YAML_DEPTH + 1));
    expect(deep.ok ? [] : deep.errors.map((e) => e.code)).toEqual(["yaml_too_deep"]);
  });

  it.each([
    ["flow sequences", "[".repeat(30_000) + "]".repeat(30_000)],
    ["flow maps", "{a: ".repeat(12_000) + "}".repeat(12_000)],
    ["block sequences on one line", "- ".repeat(30_000) + "x"],
    ["block maps", Array.from({ length: 300 }, (_, i) => `${" ".repeat(i)}k:`).join("\n")],
  ])("reports maximal nesting of %s within 64 KiB as an error, not a crash", (_name, text) => {
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_FACTORY_YAML_BYTES);
    const result = parseFactoryYaml(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("yaml_too_deep");
  });

  it("accepts exactly 64 KiB and rejects one byte more, as bytes or as a string", () => {
    expect(parseFactoryYaml(paddedTo(MAX_FACTORY_YAML_BYTES)).ok).toBe(true);
    const tooBig = paddedTo(MAX_FACTORY_YAML_BYTES + 1);
    expect(parseFactoryYaml(tooBig)).toMatchObject({ ok: false, errors: [{ code: "yaml_too_large" }] });
    expect(parseFactoryYaml(new TextDecoder().decode(tooBig))).toMatchObject({ ok: false, errors: [{ code: "yaml_too_large" }] });
    // Multi-byte characters count as their UTF-8 size, not their UTF-16 length.
    expect(parseFactoryYaml(`# ${"é".repeat(MAX_FACTORY_YAML_BYTES / 2)}`)).toMatchObject({ errors: [{ code: "yaml_too_large" }] });
  });

  it("ignores a leading BOM in bytes and in strings", () => {
    expect(parseFactoryYaml(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x3a, 0x20, 0x31]))).toEqual({ ok: true, value: { a: 1 } });
    expect(parseFactoryYaml("\uFEFFa: 1")).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects strings that aren't well-formed UTF-16 (they have no UTF-8 encoding)", () => {
    expect(parseFactoryYaml("a: \uD800\n")).toMatchObject({ ok: false, errors: [{ code: "yaml_encoding" }] });
  });

  it("treats an empty or comment-only file as null", () => {
    expect(parseFactoryYaml("")).toEqual({ ok: true, value: null });
    expect(parseFactoryYaml("# nothing\n")).toEqual({ ok: true, value: null });
  });

  it.each([
    ["an alias without its anchor", "a: *nowhere\n", "yaml_alias"],
    ["an anchor on a key", "&k a: 1\n", "yaml_alias"],
    ["a non-specific tag", "a: ! 1\n", "yaml_tag"],
    ["a verbatim tag", "a: !<tag:yaml.org,2002:str> 1\n", "yaml_tag"],
    ["a %TAG shorthand", "%TAG !e! tag:example.com,2000:\n---\na: !e!x 1\n", "yaml_tag"],
    ["a tag on a key", "!!str a: 1\n", "yaml_tag"],
    ["a duplicate key in a flow map", "{a: 1, a: 2}\n", "yaml_duplicate_key"],
    ["a duplicate key differing only in quoting", "a: 1\n'a': 2\n", "yaml_duplicate_key"],
    ["a third document marker", "a: 1\n---\n---\n", "yaml_multi_document"],
  ])("rejects %s", (_name, text, code) => {
    const result = parseFactoryYaml(text);
    expect(result.ok ? [] : result.errors.map((e) => e.code)).toEqual([code]);
  });

  it("reports yaml_* problems once per code, with a position and no file content", () => {
    const bomb = `a: &a [x, x]\n${Array.from({ length: 200 }, (_, i) => `k${i}: [*a, *a]`).join("\n")}\nb: !!str 1\nc: !!int 2\n`;
    const result = parseFactoryYaml(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { path: "", code: "yaml_alias", message: "anchors are not allowed at line 1, column 7" },
      { path: "", code: "yaml_tag", message: "explicit tags are not allowed at line 202, column 10" },
    ]);
  });

  it.each([
    ["an integer key", "1: a\n", "", "invalid_type"],
    ["a null key", "? \n: a\n", "", "invalid_type"],
    ["a collection key", "? [a]\n: b\n", "", "invalid_type"],
    ["a boolean key", "x:\n  true: 1\n", "x", "invalid_type"],
    ["an infinite number", "x: [1, -.inf]\n", "x[1]", "invalid_value"],
    ["NaN", "x: { y: .nan }\n", "x.y", "invalid_value"],
    ["an overflowing number", "x: 1e400\n", "x", "invalid_value"],
  ])("rejects %s at its path", (_name, text, path, code) => {
    expect(parseFactoryYaml(text)).toMatchObject({ ok: false, errors: [{ path, code }] });
  });

  it("never throws, whatever the input", () => {
    const inputs = ["\u0000", "\t", "[", "]", "{", "'", '"', "%", "%YAML 9.9\n---\n", "? ? ?", "- - -", ":::", "\u001b[2J"];
    for (const text of inputs) expect(() => parseFactoryYaml(text)).not.toThrow();
  });
});
