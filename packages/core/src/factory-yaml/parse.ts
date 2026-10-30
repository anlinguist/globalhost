import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Document } from "yaml";
import { formatPath, quote, sortErrors, type FactoryYamlError, type FactoryYamlErrorCode, type PathSegment } from "./errors.js";

/** docs/FACTORY-YAML.md §4. */
export const MAX_FACTORY_YAML_BYTES = 64 * 1024;
export const MAX_FACTORY_YAML_DEPTH = 32;

export type ParseFactoryYamlResult = { ok: true; value: unknown } | { ok: false; errors: FactoryYamlError[] };

const YAML_OPTIONS = {
  version: "1.2",
  schema: "core",
  merge: false, // `<<` is an ordinary key, rejected by the closed objects
  uniqueKeys: true,
  strict: true,
  prettyErrors: false, // pretty errors quote source lines; messages here quote nothing from the file
  keepSourceTokens: false,
} as const;

type AnyNode = unknown;

function fail(code: FactoryYamlErrorCode, message: string, path = ""): ParseFactoryYamlResult {
  return { ok: false, errors: [{ path, code, message }] };
}

/**
 * Parses factory.yaml text (or raw bytes) into a plain value. Hostile input is expected: the size is capped,
 * anchors, aliases and tags are rejected, nesting is bounded, and every map key becomes an own data property.
 * Never throws for any input.
 */
export function parseFactoryYaml(input: string | Uint8Array): ParseFactoryYamlResult {
  let text: string;
  if (typeof input === "string") {
    // A UTF-16 unit encodes to at least one UTF-8 byte, so the cheap check goes first.
    if (input.length > MAX_FACTORY_YAML_BYTES || new TextEncoder().encode(input).length > MAX_FACTORY_YAML_BYTES) {
      return fail("yaml_too_large", `file is larger than ${MAX_FACTORY_YAML_BYTES} bytes`);
    }
    if (!input.isWellFormed()) return fail("yaml_encoding", "file is not valid UTF-8 (lone surrogate)");
    text = input.startsWith("﻿") ? input.slice(1) : input;
  } else {
    if (input.byteLength > MAX_FACTORY_YAML_BYTES) {
      return fail("yaml_too_large", `file is larger than ${MAX_FACTORY_YAML_BYTES} bytes`);
    }
    try {
      // Default ignoreBOM=false strips one leading BOM.
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return fail("yaml_encoding", "file is not valid UTF-8");
    }
  }

  const lineCounter = new LineCounter();
  let docs: Document.Parsed[];
  try {
    docs = [...parseAllDocuments(text, { ...YAML_OPTIONS, lineCounter })];
  } catch (err) {
    // The 64 KiB cap keeps nesting far below what the composer survives (tested); this is a backstop.
    if (err instanceof RangeError) return fail("yaml_too_deep", `nesting is deeper than ${MAX_FACTORY_YAML_DEPTH} levels`);
    return fail("yaml_syntax", "YAML could not be parsed");
  }

  if (docs.length > 1) return fail("yaml_multi_document", "file contains more than one YAML document");
  const doc = docs[0];
  if (doc === undefined) return { ok: true, value: null };

  const at = (offset: number | undefined): string => {
    if (offset === undefined) return "";
    const { line, col } = lineCounter.linePos(offset);
    return ` at line ${line}, column ${col}`;
  };

  const errors: FactoryYamlError[] = [];
  for (const e of [...doc.errors, ...doc.warnings]) {
    if (e.code === "TAG_RESOLVE_FAILED") continue; // reported as yaml_tag below
    if (e.code === "DUPLICATE_KEY") {
      errors.push({ path: "", code: "yaml_duplicate_key", message: `duplicate map key${at(e.pos[0])}` });
    } else {
      errors.push({ path: "", code: "yaml_syntax", message: `YAML syntax error (${e.code})${at(e.pos[0])}` });
    }
  }

  // Iterative walk (no recursion before the depth is known): depth, anchors, aliases, explicit tags.
  const stack: Array<{ node: AnyNode; depth: number }> = [{ node: doc.contents, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || node === undefined) continue;
    const offset = (node as { range?: [number, number, number] }).range?.[0];
    if (isAlias(node)) {
      errors.push({ path: "", code: "yaml_alias", message: `aliases are not allowed${at(offset)}` });
      continue;
    }
    if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.anchor !== undefined) {
        errors.push({ path: "", code: "yaml_alias", message: `anchors are not allowed${at(offset)}` });
      }
      if (node.tag !== undefined) {
        errors.push({ path: "", code: "yaml_tag", message: `explicit tags are not allowed${at(offset)}` });
      }
    }
    if (isMap(node) || isSeq(node)) {
      if (depth + 1 > MAX_FACTORY_YAML_DEPTH) {
        errors.push({
          path: "",
          code: "yaml_too_deep",
          message: `nesting is deeper than ${MAX_FACTORY_YAML_DEPTH} levels${at(offset)}`,
        });
        break;
      }
      // Pushed in reverse so nodes are visited in document order.
      for (const item of [...node.items].reverse()) {
        if (isMap(node)) {
          const pair = item as { key: AnyNode; value: AnyNode };
          stack.push({ node: pair.value, depth: depth + 1 }, { node: pair.key, depth: depth + 1 });
        } else {
          stack.push({ node: item, depth: depth + 1 });
        }
      }
    }
  }
  if (errors.length > 0) {
    // First occurrence per code: a hostile file can't turn into thousands of lines of output.
    const firstPerCode = new Map<FactoryYamlErrorCode, FactoryYamlError>();
    for (const e of errors) if (!firstPerCode.has(e.code)) firstPerCode.set(e.code, e);
    return { ok: false, errors: sortErrors([...firstPerCode.values()]) };
  }

  const valueErrors: FactoryYamlError[] = [];
  const value = toPlain(doc.contents, [], valueErrors);
  if (valueErrors.length > 0) return { ok: false, errors: sortErrors(valueErrors) };
  return { ok: true, value };
}

// Depth is bounded (≤ 32) by the walk above, so recursion here is safe.
function toPlain(node: AnyNode, path: PathSegment[], errors: FactoryYamlError[]): unknown {
  if (node === null || node === undefined) return null;
  if (isScalar(node)) {
    const v = node.value;
    if (typeof v === "number" && !Number.isFinite(v)) {
      errors.push({ path: formatPath(path), code: "invalid_value", message: "numbers must be finite" });
    }
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    errors.push({ path: formatPath(path), code: "invalid_type", message: "unsupported scalar type" });
    return null;
  }
  if (isSeq(node)) return node.items.map((item, i) => toPlain(item, [...path, i], errors));
  if (isMap(node)) {
    const out: Record<string, unknown> = {};
    for (const pair of node.items) {
      const keyNode: AnyNode = pair.key;
      const key = isScalar(keyNode) ? keyNode.value : undefined;
      if (typeof key !== "string") {
        const shown = isScalar(keyNode) ? quote(key) : keyNode === null || keyNode === undefined ? "an empty key" : "a collection";
        errors.push({ path: formatPath(path), code: "invalid_type", message: `map keys must be strings, found ${shown}` });
        continue;
      }
      // defineProperty, not assignment: a `__proto__` key stays an own data property and never sets the prototype.
      Object.defineProperty(out, key, {
        value: toPlain(pair.value, [...path, key], errors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  errors.push({ path: formatPath(path), code: "invalid_type", message: "unsupported YAML node" });
  return null;
}
