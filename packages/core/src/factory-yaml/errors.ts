// Stable error codes for factory.yaml parsing and validation (docs/FACTORY-YAML.md §5).
// `--json` consumers depend on these strings: add new codes, never rename or reuse one.
export const FACTORY_YAML_ERROR_CODES = [
  "yaml_too_large",
  "yaml_encoding",
  "yaml_syntax",
  "yaml_multi_document",
  "yaml_duplicate_key",
  "yaml_alias",
  "yaml_tag",
  "yaml_too_deep",
  "invalid_type",
  "invalid_value",
  "unknown_key",
  "missing_key",
  "branch_prefix_fixed",
  "unknown_profile",
  "unknown_adapter",
  "adapter_not_allowed",
  "profile_config",
  "adapter_config",
  "path_overlap",
  "dependency_unknown",
  "dependency_self",
  "dependency_cycle",
  "binding_syntax",
  "binding_input_unknown",
  "binding_not_dependency",
  "binding_output_unknown",
  "binding_preview_disabled",
  "env_dev_missing",
  "env_shares_prod_project",
  "automerge_requires_l3",
  "guardrail_conflict",
  "limits_inconsistent",
  "owner_duplicate",
] as const;

export type FactoryYamlErrorCode = (typeof FACTORY_YAML_ERROR_CODES)[number];

export interface FactoryYamlError {
  /** Dotted path with indexes, e.g. `parts.web.dependsOn[0]`; `""` for the document as a whole. */
  path: string;
  code: FactoryYamlErrorCode;
  message: string;
}

export type PathSegment = string | number;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `["parts", "Web-App", "dependsOn", 0]` → `parts["Web-App"].dependsOn[0]`. */
export function formatPath(segments: readonly PathSegment[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (IDENTIFIER.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

const MAX_QUOTE = 80;

/** Quotes a value from the file for a message: JSON-escaped, at most 80 characters of it. */
export function quote(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || value === null) text = String(value);
  else if (Array.isArray(value)) return "a list";
  else if (typeof value === "object") return "a map";
  else return typeof value;
  const chars = Array.from(text);
  const cut = chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : text;
  return typeof value === "string" ? JSON.stringify(cut) : cut;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts by path, then code (then message, for determinism) and drops exact duplicates. */
export function sortErrors(errors: readonly FactoryYamlError[]): FactoryYamlError[] {
  const seen = new Set<string>();
  const unique: FactoryYamlError[] = [];
  for (const e of errors) {
    const key = JSON.stringify([e.path, e.code, e.message]);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }
  return unique.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.message, b.message));
}
