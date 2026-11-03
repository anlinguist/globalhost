// Ecosystem range syntaxes → core's canonical range grammar (packages/core/src/toolchain.ts), and back for install
// hints. Inputs come from repo files, so they're untrusted: each converter accepts a strict subset and returns
// undefined for anything else (pre-release tags, build metadata, unknown operators, stray characters).
import { formatVersionRange, parseVersionRange, type Comparator, type RangeOp, type VersionRange } from "@globalhost/core";

export const MAX_SPEC_CHARS = 100;
const NUM = /^(?:0|[1-9]\d{0,5})$/;

/** "Any version": the source pins nothing. */
export const ANY = Symbol("any");
export type Converted = string | typeof ANY | undefined;

function finish(range: VersionRange): string | undefined {
  try {
    // formatVersionRange throws unless the text parses back in the canonical grammar.
    return formatVersionRange(range);
  } catch {
    return undefined;
  }
}

/** "1", "1.2", "1.2.3", with x/X/* wildcards ending it ("1.x", "1.2.*"). [] means "any". */
function partial(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length > 3) return undefined;
  const out: number[] = [];
  let wild = false;
  for (const p of parts) {
    if (p === "x" || p === "X" || p === "*") {
      wild = true;
      continue;
    }
    if (wild || !NUM.test(p)) return undefined;
    out.push(Number(p));
  }
  return out;
}

const bump = (v: readonly number[], at: number): number[] => [...v.slice(0, at), (v[at] ?? 0) + 1];

/** One npm comparator token (op glued to its version) → comparators; [] means "any". */
function npmComparator(token: string): Comparator[] | undefined {
  const m = /^(\^|~|>=|<=|>|<|=)?v?([0-9xX*.]+)$/.exec(token);
  if (!m?.[2]) return undefined;
  const v = partial(m[2]);
  if (!v) return undefined;
  const op = m[1];
  if (v.length === 0) return op === undefined || op === "=" || op === ">=" || op === "^" || op === "~" ? [] : undefined;
  switch (op) {
    case undefined:
    case "=":
      return [{ op: "=", version: v }];
    case "^": {
      // ^1.2.3 → >=1.2.3 <2; ^0.2.3 → >=0.2.3 <0.3; ^0.0.3 → =0.0.3; ^22 → =22.
      const first = v.findIndex((n) => n !== 0);
      const at = first === -1 ? v.length - 1 : first;
      if (at >= v.length - 1) return [{ op: "=", version: v.slice(0, at + 1) }];
      return [
        { op: ">=", version: v },
        { op: "<", version: bump(v, at) },
      ];
    }
    case "~":
      // ~1.2.3 → >=1.2.3 <1.3; ~1.2 → =1.2; ~1 → =1.
      return v.length <= 2 ? [{ op: "=", version: v }] : [{ op: ">=", version: v }, { op: "<", version: bump(v, 1) }];
    default:
      return [{ op: op as RangeOp, version: v }];
  }
}

/**
 * An npm semver range (package.json `engines`, setup-node's `node-version`, `.node-version`) → canonical.
 * Supports exact and partial versions, x-ranges, ^, ~, comparators, hyphen ranges and `||`.
 */
export function npmRangeToCanonical(text: string): Converted {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SPEC_CHARS || !/^[0-9xX*. \t<>=^~|v-]+$/.test(trimmed)) return undefined;
  const range: VersionRange = [];
  for (const setText of trimmed.split("||")) {
    const s = setText.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
    if (s === "") return undefined;
    const hyphen = /^v?([0-9xX*.]+)\s+-\s+v?([0-9xX*.]+)$/.exec(s);
    let set: Comparator[] = [];
    if (hyphen?.[1] && hyphen[2]) {
      const lo = partial(hyphen[1]);
      const hi = partial(hyphen[2]);
      if (!lo || !hi) return undefined;
      if (lo.length > 0) set.push({ op: ">=", version: lo });
      if (hi.length > 0) set.push({ op: "<=", version: hi });
    } else {
      for (const token of s.split(/\s+/)) {
        const cs = npmComparator(token);
        if (!cs) return undefined;
        set = set.concat(cs);
      }
    }
    if (set.length === 0) return ANY;
    if (set.length > 4) return undefined;
    range.push(set);
  }
  return finish(range);
}

/**
 * A PEP 440 specifier set (pyproject `requires-python`, `[tool.uv] required-version`) → canonical. Supports
 * `==` (with or without `.*`), `>=`, `>`, `<=`, `<`, `~=`, comma-separated. `!=`, `===` and pre-/post-/dev-releases
 * aren't expressible or aren't accepted, so they make the whole specifier undefined.
 */
export function pep440ToCanonical(text: string): Converted {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SPEC_CHARS || !/^[0-9.* \t<>=~,]+$/.test(trimmed)) return undefined;
  const set: Comparator[] = [];
  for (const spec of trimmed.split(",")) {
    const m = /^\s*(~=|==|>=|<=|>|<)\s*((?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){0,2})(\.\*)?\s*$/.exec(spec);
    if (!m?.[1] || !m[2]) return undefined;
    const v = m[2].split(".").map(Number);
    const star = m[3] !== undefined;
    if (star && m[1] !== "==") return undefined;
    const pad = (x: number[]) => [...x, 0, 0].slice(0, 3);
    switch (m[1]) {
      case "==":
        // ==3.12.* is any 3.12.x; ==3.12 means exactly 3.12.0.
        set.push({ op: "=", version: star ? v : pad(v) });
        break;
      case "~=":
        if (v.length < 2) return undefined;
        set.push({ op: ">=", version: v }, { op: "<", version: bump(v, v.length - 2) });
        break;
      case ">=":
      case "<":
        set.push({ op: m[1], version: v });
        break;
      default:
        // > and <= compare whole versions in PEP 440, so pad: >3.12 admits 3.12.1.
        set.push({ op: m[1] as RangeOp, version: pad(v) });
    }
  }
  if (set.length > 4) return undefined;
  return finish([set]);
}

/**
 * A canonical range → a PEP 440 specifier set, for install hints. Only the first `||` alternative is used (PEP 440
 * has no "or"). Partial `>` and `<=` become their whole-version equivalents.
 */
export function canonicalToPep440(range: string): string {
  const parsed = parseVersionRange(range);
  const set = parsed?.[0];
  if (!set) throw new Error("not a canonical version range");
  return set
    .map((c) => {
      const v = c.version.join(".");
      if (c.op === "=") return c.version.length === 3 ? `==${v}` : `==${v}.*`;
      if (c.op === ">" && c.version.length < 3) return `>=${bump(c.version, c.version.length - 1).join(".")}`;
      if (c.op === "<=" && c.version.length < 3) return `<${bump(c.version, c.version.length - 1).join(".")}`;
      return `${c.op}${v}`;
    })
    .join(",");
}
