// Path policy (FACTORY-YAML §3.6, §3.8): which agent-changed files the publisher rejects outright
// (immutable) and which need the owner's approval (loadBearing). Matching ignores case, so a case
// variant of a protected path can't slip past on a case-insensitive checkout.

/** Repo-relative path → does the glob match it? Implements the small dialect in FACTORY-YAML §3.6. */
export function globMatch(pattern: string, path: string): boolean {
  const pat = pattern.toLowerCase().split("/");
  const segs = path.toLowerCase().split("/");
  const memo = new Map<string, boolean>();

  const match = (pi: number, si: number): boolean => {
    const key = `${pi},${si}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result: boolean;
    if (pi === pat.length) result = si === segs.length;
    else if (pat[pi] === "**") {
      // Zero or more whole segments.
      result = match(pi + 1, si) || (si < segs.length && match(pi, si + 1));
    } else {
      result = si < segs.length && segmentMatch(pat[pi]!, segs[si]!) && match(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function segmentMatch(pattern: string, segment: string): boolean {
  // `*` and `?` stay within the segment; everything else is literal.
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`, "s").test(segment);
}

export interface PathPolicyInput {
  immutable: readonly string[];
  loadBearing: readonly string[];
}

export interface PathPolicyResult {
  /** Paths the publisher must refuse to push, with the pattern that protects each. */
  rejected: Array<{ path: string; pattern: string }>;
  /** Paths that need `needs:owner-approval`, with the pattern that flagged each. */
  needsApproval: Array<{ path: string; pattern: string }>;
  /** Paths that aren't plain repo-relative paths at all; also rejected. */
  malformed: string[];
}

// Git never reports these from a diff, so seeing one means the input wasn't a git path list.
const MALFORMED_SHAPE = /(^\/)|(^|\/)\.\.?(\/|$)|\\|\/\/|\/$/;
const hasControlChar = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

export function evaluatePathPolicy(paths: readonly string[], policy: PathPolicyInput): PathPolicyResult {
  const result: PathPolicyResult = { rejected: [], needsApproval: [], malformed: [] };
  for (const path of paths) {
    if (path === "" || MALFORMED_SHAPE.test(path) || hasControlChar(path)) {
      result.malformed.push(path);
      continue;
    }
    const immutable = policy.immutable.find((p) => globMatch(p, path));
    if (immutable) {
      result.rejected.push({ path, pattern: immutable });
      continue;
    }
    const loadBearing = policy.loadBearing.find((p) => globMatch(p, path));
    if (loadBearing) result.needsApproval.push({ path, pattern: loadBearing });
  }
  return result;
}

export const pathPolicyAllows = (r: PathPolicyResult) => r.rejected.length === 0 && r.malformed.length === 0;
