import type { z } from "zod";
import { formatPath, quote, sortErrors, type FactoryYamlError, type FactoryYamlErrorCode, type PathSegment } from "./errors.js";
import type { Registry } from "./registry.js";
import {
  AUTO_MERGE_CATEGORIES,
  AUTONOMY_LEVELS,
  BINDING_INPUT_PATTERN,
  ENVIRONMENT_NAME_PATTERN,
  factoryYamlShape,
  PART_NAME_PATTERN,
  IMMUTABLE_BASELINE,
  NOTIFICATION_MODES,
  type FactoryYamlShape,
} from "./schema.js";

type NotificationMode = (typeof NOTIFICATION_MODES)[number];

/** A resolved `${parts.<part>.preview.<output>}` reference. */
export interface PreviewBinding {
  part: string;
  output: string;
}

export interface PartConfig {
  path: string;
  profile: string;
  /** Output of the profile's `configSchema` (its defaults applied). */
  config: unknown;
  preview: { enabled: boolean; bindings: Record<string, PreviewBinding> };
  release: Array<{ adapter: string; config: unknown }>;
  dependsOn: string[];
}

/** factory.yaml after validation: every default applied and the immutable baseline merged. */
export interface FactoryConfig {
  version: 1;
  product: string;
  owners: Array<{ login: string; id: number }>;
  autonomy: (typeof AUTONOMY_LEVELS)[number];
  project: string | null;
  git: { defaultBranch: string; baseBranch: string };
  environments: Record<string, { gcpProject: string; region: string }>;
  parts: Record<string, PartConfig>;
  limits: { maxConcurrentBuilders: number; perRunUsd: number; perRunMinutes: number; dailyUsd: number };
  guardrails: { loadBearing: string[]; immutable: string[] };
  autoMerge: Array<(typeof AUTO_MERGE_CATEGORIES)[number]>;
  notifications: { blocking: NotificationMode; previews: NotificationMode; routine: NotificationMode };
}

export type ValidateFactoryConfigResult = { ok: true; config: FactoryConfig } | { ok: false; errors: FactoryYamlError[] };

const BINDING_REFERENCE = /^\$\{parts\.([a-z][a-z0-9]{0,19})\.preview\.([a-z][a-zA-Z0-9]{0,39})\}$/;
const MAX_FOREIGN_MESSAGE = 200;

const BRANCH_PREFIX_MESSAGE =
  "git.branchPrefix is not configurable: agent branches are always factory/…, the only branches the publisher may push (CLAUDE.md #3, ADR-0013)";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads a value from the raw input by path, following own properties only. */
function getAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === "number") cur = cur[seg];
    else if (isRecord(cur) && typeof seg === "string" && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a map";
  return `${typeof v} ${quote(v)}`;
}

const EXPECTED_NAMES: Record<string, string> = { object: "a map", record: "a map", array: "a list" };

function truncate(text: string): string {
  return text.length > MAX_FOREIGN_MESSAGE ? `${text.slice(0, MAX_FOREIGN_MESSAGE)}…` : text;
}

/**
 * Maps zod issues to factory.yaml errors. `raw` is the input value at `base`; `override` replaces the code
 * (profile_config / adapter_config) while keeping the message.
 */
function mapIssues(
  issues: readonly z.core.$ZodIssue[],
  raw: unknown,
  base: readonly PathSegment[],
  override?: FactoryYamlErrorCode,
): FactoryYamlError[] {
  const out: FactoryYamlError[] = [];
  const push = (rel: readonly PropertyKey[], code: FactoryYamlErrorCode, message: string) => {
    const segs = [...base, ...rel.map((s) => (typeof s === "number" ? s : String(s)))];
    out.push({ path: formatPath(segs), code: override ?? code, message });
  };

  for (const issue of issues) {
    const rel = issue.path;
    const actual = getAt(raw, rel);
    switch (issue.code) {
      case "unrecognized_keys":
        for (const key of issue.keys) {
          const fullPath = formatPath([...base, ...rel.map(String), key]);
          if (override === undefined && fullPath === "git.branchPrefix") push([...rel, key], "branch_prefix_fixed", BRANCH_PREFIX_MESSAGE);
          else push([...rel, key], "unknown_key", `unknown key ${quote(key)}`);
        }
        break;
      case "invalid_type": {
        const parent = getAt(raw, rel.slice(0, -1));
        const last = rel.at(-1);
        if (rel.length > 0 && isRecord(parent) && typeof last === "string" && !Object.hasOwn(parent, last)) {
          push(rel, "missing_key", `missing required key ${quote(last)}`);
        } else if (issue.expected === "int" && typeof actual === "number") {
          push(rel, "invalid_value", `${quote(actual)}: expected an integer`);
        } else {
          const expected = EXPECTED_NAMES[issue.expected] ?? issue.expected;
          push(rel, "invalid_type", `expected ${expected}, found ${describe(actual)}`);
        }
        break;
      }
      case "invalid_value": {
        const types = new Set(issue.values.map((v) => typeof v));
        const options = issue.values.map((v) => JSON.stringify(v)).join(", ");
        if (!types.has(typeof actual)) push(rel, "invalid_type", `expected one of ${options}, found ${describe(actual)}`);
        else push(rel, "invalid_value", `${quote(actual)}: expected one of ${options}`);
        break;
      }
      case "invalid_key": {
        const key = rel.at(-1);
        const inner = issue.issues[0]?.message ?? "invalid key";
        push(rel, "invalid_value", `${quote(typeof key === "string" ? key : String(key))}: ${truncate(inner)}`);
        break;
      }
      default:
        push(rel, "invalid_value", `${quote(actual)}: ${truncate(issue.message)}`);
    }
  }
  return out;
}

/** Runs a profile/adapter schema, which must be synchronous; a throwing schema is reported, not propagated. */
function runForeignSchema(
  schema: z.ZodType,
  raw: unknown,
  base: readonly PathSegment[],
  code: "profile_config" | "adapter_config",
  errors: FactoryYamlError[],
): unknown {
  let result;
  try {
    result = schema.safeParse(raw);
  } catch {
    errors.push({ path: formatPath(base), code, message: "the config schema threw; profile and adapter schemas must be synchronous" });
    return undefined;
  }
  if (result.success) return result.data;
  // A schema may fail without issues only via a bug; still report it.
  if (result.error.issues.length === 0) errors.push({ path: formatPath(base), code, message: "config is invalid" });
  errors.push(...mapIssues(result.error.issues, raw, base, code));
  return undefined;
}

/**
 * Validates a parsed factory.yaml value (docs/FACTORY-YAML.md §5). Synchronous, deterministic, no I/O.
 * Stage 1 checks shape; only if that passes, stage 2 runs every cross-field and registry check.
 */
export function validateFactoryConfig(value: unknown, registry: Registry): ValidateFactoryConfigResult {
  const shape = factoryYamlShape.safeParse(value);
  const { errors: keyErrors, badRecords } = recordKeyErrors(value);
  if (!shape.success || keyErrors.length > 0) {
    // One error per (path, code): a value breaking two rules of one field reports once.
    const seen = new Set<string>();
    // zod counted a record without its skipped `__proto__` key; its entry count is moot once that key is reported.
    const issues = shape.success
      ? []
      : mapIssues(shape.error.issues, value, []).filter((e) => !(badRecords.has(e.path) && e.code === "invalid_value"));
    const errors = [...issues, ...keyErrors].filter((e) => {
      const key = `${e.path}\u0000${e.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ok: false, errors: sortErrors(errors) };
  }
  return crossCheck(shape.data, value, registry);
}

/**
 * zod's records skip a `__proto__` key without an issue, which would silently drop a part, environment or
 * binding. So the name patterns are also checked here, on the raw value's own keys.
 */
function recordKeyErrors(value: unknown): { errors: FactoryYamlError[]; badRecords: Set<string> } {
  const errors: FactoryYamlError[] = [];
  const badRecords = new Set<string>();
  const checkKeys = (path: PathSegment[], pattern: RegExp, what: string): string[] => {
    const rec = getAt(value, path);
    if (!isRecord(rec)) return [];
    const keys = Object.keys(rec);
    for (const key of keys) {
      if (!pattern.test(key)) {
        badRecords.add(formatPath(path));
        errors.push({ path: formatPath([...path, key]), code: "invalid_value", message: `${quote(key)}: not a valid ${what} name` });
      }
    }
    return keys;
  };
  checkKeys(["environments"], ENVIRONMENT_NAME_PATTERN, "environment");
  for (const part of checkKeys(["parts"], PART_NAME_PATTERN, "part")) {
    checkKeys(["parts", part, "preview", "bindings"], BINDING_INPUT_PATTERN, "binding input");
  }
  return { errors, badRecords };
}

function crossCheck(s: FactoryYamlShape, raw: unknown, registry: Registry): ValidateFactoryConfigResult {
  const errors: FactoryYamlError[] = [];
  const push = (path: PathSegment[], code: FactoryYamlErrorCode, message: string) =>
    errors.push({ path: formatPath(path), code, message });

  // Owners: unique ids, and logins unique ignoring case.
  const ids = new Map<number, number>();
  const logins = new Map<string, number>();
  s.owners.forEach((o, i) => {
    const prevId = ids.get(o.id);
    if (prevId !== undefined) push(["owners", i, "id"], "owner_duplicate", `owner id ${o.id} is already listed at owners[${prevId}]`);
    else ids.set(o.id, i);
    const login = o.login.toLowerCase();
    const prevLogin = logins.get(login);
    if (prevLogin !== undefined) {
      push(["owners", i, "login"], "owner_duplicate", `owner login ${quote(o.login)} is already listed at owners[${prevLogin}]`);
    } else logins.set(login, i);
  });

  const parts = s.parts;
  const partNames = Object.keys(parts);
  const hasPart = (n: string) => Object.hasOwn(parts, n);
  const hostedPreviews: string[] = [];
  const normalizedParts: Record<string, PartConfig> = {};

  for (const name of partNames) {
    const p = parts[name]!;
    const base: PathSegment[] = ["parts", name];
    const profile = registry.profile(p.profile);
    let config: unknown;
    if (profile === undefined) {
      push([...base, "profile"], "unknown_profile", `no registered profile ${quote(p.profile)}`);
    } else {
      // The raw value, not zod's copy, so the profile schema sees exactly what the file said.
      const rawConfig = getAt(raw, ["parts", name, "config"]) ?? {};
      config = runForeignSchema(profile.configSchema, rawConfig, [...base, "config"], "profile_config", errors);
    }

    const release = p.release.map((target, i) => {
      const tBase: PathSegment[] = [...base, "release", i];
      const adapter = registry.adapter(target.adapter);
      if (adapter === undefined) {
        push([...tBase, "adapter"], "unknown_adapter", `no registered adapter ${quote(target.adapter)}`);
        return { adapter: target.adapter, config: undefined };
      }
      if (profile !== undefined && !profile.release.allowedAdapters.includes(target.adapter)) {
        push([...tBase, "adapter"], "adapter_not_allowed", `profile ${quote(p.profile)} does not allow adapter ${quote(target.adapter)}`);
      }
      const rawConfig = getAt(raw, ["parts", name, "release", i, "config"]) ?? {};
      return { adapter: target.adapter, config: runForeignSchema(adapter.configSchema, rawConfig, [...tBase, "config"], "adapter_config", errors) };
    });

    p.dependsOn.forEach((dep, i) => {
      if (dep === name) push([...base, "dependsOn", i], "dependency_self", `part ${quote(name)} cannot depend on itself`);
      else if (!hasPart(dep)) push([...base, "dependsOn", i], "dependency_unknown", `no part named ${quote(dep)}`);
    });

    const bindings: Record<string, PreviewBinding> = {};
    for (const [input, ref] of Object.entries(p.preview.bindings)) {
      const bPath: PathSegment[] = [...base, "preview", "bindings", input];
      if (!p.preview.enabled) {
        push(bPath, "binding_preview_disabled", `part ${quote(name)} has its preview disabled, so its bindings can never apply`);
      }
      if (profile !== undefined && !profile.preview.inputs.includes(input)) {
        push(bPath, "binding_input_unknown", `profile ${quote(p.profile)} declares no preview input ${quote(input)}`);
      }
      const m = BINDING_REFERENCE.exec(ref);
      if (m === null) {
        push(bPath, "binding_syntax", `${quote(ref)}: a binding must be exactly one \${parts.<part>.preview.<output>} reference`);
        continue;
      }
      const [, refPart = "", output = ""] = m;
      bindings[input] = { part: refPart, output };
      if (!p.dependsOn.includes(refPart)) {
        push(bPath, "binding_not_dependency", `part ${quote(refPart)} must be listed in parts.${name}.dependsOn to bind to it`);
        continue;
      }
      if (refPart === name || !hasPart(refPart)) continue; // reported on dependsOn
      const provider = parts[refPart]!;
      if (!provider.preview.enabled) {
        push(bPath, "binding_preview_disabled", `part ${quote(refPart)} has its preview disabled`);
      }
      const providerProfile = registry.profile(provider.profile);
      if (providerProfile !== undefined && !providerProfile.preview.outputs.includes(output)) {
        push(bPath, "binding_output_unknown", `profile ${quote(provider.profile)} declares no preview output ${quote(output)}`);
      }
    }

    if (profile !== undefined && p.preview.enabled && profile.preview.kinds.includes("url")) hostedPreviews.push(name);

    normalizedParts[name] = {
      path: p.path,
      profile: p.profile,
      config,
      preview: { enabled: p.preview.enabled, bindings },
      release,
      dependsOn: p.dependsOn,
    };
  }

  // Paths: distinct and non-nested, ignoring case (a case-insensitive checkout must not merge two parts).
  const sorted = [...partNames].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const [ni, nj] = [sorted[i]!, sorted[j]!];
      const a = parts[ni]!.path.toLowerCase();
      const b = parts[nj]!.path.toLowerCase();
      if (a === b || a === "." || b === "." || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) {
        push(["parts", nj, "path"], "path_overlap", `${quote(parts[nj]!.path)} overlaps part ${quote(ni)} at ${quote(parts[ni]!.path)}`);
      }
    }
  }

  for (const cycle of findCycles(parts)) {
    push(["parts", cycle[0]!, "dependsOn"], "dependency_cycle", `dependency cycle: ${[...cycle, cycle[0]].join(" → ")}`);
  }

  const envs = s.environments;
  if (hostedPreviews.length > 0 && !Object.hasOwn(envs, "dev")) {
    push(["environments"], "env_dev_missing", `hosted previews (parts ${hostedPreviews.join(", ")}) deploy into a "dev" environment, which is not declared`);
  }
  const prod = Object.hasOwn(envs, "prod") ? envs.prod : undefined;
  if (prod !== undefined) {
    for (const [envName, env] of Object.entries(envs)) {
      if (envName !== "prod" && env.gcpProject === prod.gcpProject) {
        push(["environments", envName, "gcpProject"], "env_shares_prod_project", `environment ${quote(envName)} uses prod's GCP project ${quote(env.gcpProject)}`);
      }
    }
  }

  if (s.autoMerge.length > 0 && s.autonomy !== "L3") {
    push(["autoMerge"], "automerge_requires_l3", `autoMerge must be empty unless autonomy is L3 (it is ${s.autonomy})`);
  }

  if (s.limits.perRunUsd > s.limits.dailyUsd) {
    push(["limits", "perRunUsd"], "limits_inconsistent", `perRunUsd ${s.limits.perRunUsd} exceeds dailyUsd ${s.limits.dailyUsd}`);
  }

  const immutable = [...new Set<string>([...IMMUTABLE_BASELINE, ...s.guardrails.immutable])];
  const immutableFolded = new Set(immutable.map((g) => g.toLowerCase()));
  s.guardrails.loadBearing.forEach((g, i) => {
    if (immutableFolded.has(g.toLowerCase())) {
      push(["guardrails", "loadBearing", i], "guardrail_conflict", `${quote(g)} is also immutable (listed or in the always-immutable baseline)`);
    }
  });

  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };

  return {
    ok: true,
    config: {
      version: s.version,
      product: s.product,
      owners: s.owners,
      autonomy: s.autonomy,
      project: s.project,
      git: { defaultBranch: s.git.defaultBranch, baseBranch: s.git.baseBranch ?? s.git.defaultBranch },
      environments: s.environments,
      parts: normalizedParts,
      limits: s.limits,
      guardrails: { loadBearing: [...new Set(s.guardrails.loadBearing)], immutable },
      autoMerge: s.autoMerge,
      notifications: s.notifications,
    },
  };
}

/** One cycle per strongly connected component (size > 1), starting at its alphabetically first part. */
function findCycles(parts: FactoryYamlShape["parts"]): string[][] {
  const names = Object.keys(parts).sort();
  const edges = new Map<string, string[]>(
    names.map((n) => [n, [...new Set(parts[n]!.dependsOn.filter((d) => d !== n && Object.hasOwn(parts, d)))].sort()]),
  );

  // Tarjan's SCC; at most 20 parts, so recursion depth is trivial.
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v)!) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  };
  for (const n of names) if (!idx.has(n)) visit(n);

  // Shortest cycle through the SCC's first part (BFS inside the SCC).
  return sccs.map((scc) => {
    const members = new Set(scc);
    const start = [...scc].sort()[0]!;
    const prev = new Map<string, string>();
    const queue = [start];
    let last: string | undefined;
    while (queue.length > 0 && last === undefined) {
      const v = queue.shift()!;
      for (const w of edges.get(v)!) {
        if (!members.has(w)) continue;
        if (w === start) {
          last = v;
          break;
        }
        if (!prev.has(w)) {
          prev.set(w, v);
          queue.push(w);
        }
      }
    }
    const cycle: string[] = [];
    for (let v: string | undefined = last; v !== undefined && v !== start; v = prev.get(v)) cycle.unshift(v);
    return [start, ...cycle];
  });
}
