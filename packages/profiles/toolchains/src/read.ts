// Capped, strict reads of version files through a RepoSnapshot. Everything read is untrusted repo content: it is
// parsed, never echoed. Notes use only fixed text and repo paths the caller built from fixed names.
import type { RepoSnapshot } from "@globalhost/core";

/** Version files (.nvmrc, .python-version, …) are a line or two; anything bigger isn't one. */
export const MAX_VERSION_FILE_CHARS = 1024;
/** Manifests (package.json, pyproject.toml) and the CI workflow. */
export const MAX_MANIFEST_CHARS = 256 * 1024;

export type Read = { kind: "absent" } | { kind: "too-big" } | { kind: "ok"; text: string };

export async function readCapped(repo: RepoSnapshot, path: string, max: number): Promise<Read> {
  if (!repo.files.includes(path)) return { kind: "absent" };
  const text = await repo.readFile(path);
  if (text === undefined) return { kind: "absent" };
  if (text.length > max) return { kind: "too-big" };
  return { kind: "ok", text };
}

export function join(dir: string, file: string): string {
  return dir === "." || dir === "" ? file : `${dir.replace(/\/+$/, "")}/${file}`;
}

/** `dir`, then each parent up to the repo root ("."). */
export function selfAndParents(dir: string): string[] {
  const out: string[] = [];
  let d: string | undefined = dir === "" ? "." : dir.replace(/\/+$/, "");
  while (d !== undefined) {
    out.push(d);
    if (d === ".") break;
    const i = d.lastIndexOf("/");
    d = i === -1 ? "." : d.slice(0, i);
  }
  return out;
}

/**
 * The first meaningful line of a version file: skips blank lines and `#` comments, drops a trailing ` # comment`.
 * Undefined when there is none.
 */
export function firstLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line !== "" && !line.startsWith("#")) return line;
  }
  return undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** package.json as an object, or a fixed-text reason it couldn't be read. */
export async function readPackageJson(repo: RepoSnapshot, path: string): Promise<{ pkg?: Record<string, unknown>; note?: string }> {
  const r = await readCapped(repo, path, MAX_MANIFEST_CHARS);
  if (r.kind === "absent") return {};
  if (r.kind === "too-big") return { note: `${path} is too large to read; ignored` };
  try {
    const parsed: unknown = JSON.parse(r.text);
    return isRecord(parsed) ? { pkg: parsed } : { note: `${path} is not a JSON object; ignored` };
  } catch {
    return { note: `${path} is not valid JSON; ignored` };
  }
}

/** A string field of a nested object (e.g. engines.node), only when it is an own property holding a string. */
export function stringAt(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return typeof cur === "string" ? cur : undefined;
}

export type TomlLookup = { kind: "absent" } | { kind: "invalid" } | { kind: "ok"; value: string };

const TABLE_HEADER = /^\s*\[\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*\]\s*(?:#.*)?$/;
const ARRAY_TABLE = /^\s*\[\[/;

/**
 * A single-line string value `key = "…"` (or '…') directly in `[table]` of a TOML file. Line-based on purpose: it
 * reads only this simple, common form (bare dotted table names, a one-line basic or literal string without
 * escapes) and reports anything else for the key as invalid rather than guessing.
 */
export function tomlString(text: string, table: string, key: string): TomlLookup {
  let current = "";
  let found: TomlLookup = { kind: "absent" };
  const keyLine = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*=`);
  for (const line of text.split(/\r?\n/)) {
    if (ARRAY_TABLE.test(line)) {
      current = "\u0000array";
      continue;
    }
    const header = TABLE_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1].replace(/\s+/g, "");
      continue;
    }
    if (current !== table || !keyLine.test(line)) continue;
    if (found.kind !== "absent") return { kind: "invalid" }; // a repeated key is invalid TOML
    const m = /=\s*(?:"([^"\\\n]*)"|'([^'\n]*)')\s*(?:#.*)?$/.exec(line);
    const value = m?.[1] ?? m?.[2];
    found = value === undefined ? { kind: "invalid" } : { kind: "ok", value };
  }
  return found;
}
