// Shared toolchain detection for profiles (P2-01): reads a part's version files through a RepoSnapshot and
// returns core's generic Toolchain. Not a profile itself; profiles pick the detectors for their ecosystem
// (web-app: node, and bun when the part uses it; a Python service: python and uv). Add an ecosystem by adding a
// detector here that converts its version syntax into core's canonical range grammar.
import { MAX_TOOLCHAIN_NOTES, ToolchainSchema, type Toolchain } from "@globalhost/core";

export { dependencyChange, DEPENDENCY_CHANGE_GLOBS, MAX_LOCKFILE_CHARS } from "./dependency-change.js";
export { bunRequirement, CI_WORKFLOW, detectBun, detectNode, NODE_VERSION_FILES, nodeRequirement } from "./node.js";
export { detectPython, detectUv, pythonRequirement, uvRequirement } from "./python.js";
export { ANY, UNSATISFIABLE, canonicalToPep440, MAX_SPEC_CHARS, npmRangeToCanonical, pep440ToCanonical, type Converted } from "./ranges.js";
export { MAX_MANIFEST_CHARS, MAX_VERSION_FILE_CHARS, tomlString } from "./read.js";

/** One part's toolchain from several detectors (each covering different tools), validated. */
export function joinToolchains(...parts: Toolchain[]): Toolchain {
  const notes = [...new Set(parts.flatMap((p) => p.notes))].map((n) => n.slice(0, 300)).slice(0, MAX_TOOLCHAIN_NOTES);
  return ToolchainSchema.parse({ tools: parts.flatMap((p) => p.tools), notes });
}
