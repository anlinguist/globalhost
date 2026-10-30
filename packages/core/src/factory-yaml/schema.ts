import { z } from "zod";

// Shape (stage 1) of factory.yaml v1: docs/FACTORY-YAML.md §2–3. Every object is closed.
// Each string rule is a single regex, so a bad value yields one issue and the JSON Schema carries the same pattern.

export const PRODUCT_PATTERN = /^(?=.{2,31}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const LOGIN_PATTERN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
export const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9]{0,15}$/;
export const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const REGION_PATTERN = /^[a-z]+-[a-z]+[0-9]+$/;
export const PART_NAME_PATTERN = /^[a-z][a-z0-9]{0,19}$/;
export const DESCRIPTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** Binding keys are profile input names: upper-case environment-variable style (rejects `__proto__` and friends). */
export const BINDING_INPUT_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Preview output names a profile declares. */
export const PREVIEW_OUTPUT_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;
export const BRANCH_PATTERN = /^(?![-/])(?!.*\/\/)(?!.*\.\.)(?!.*(?:\/|\.lock)$)[A-Za-z0-9._/-]{1,100}$/;
const PATH_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._@+-]+`;
export const REPO_PATH_PATTERN = new RegExp(String.raw`^(?=.{1,200}$)(?:\.|${PATH_SEGMENT}(?:/${PATH_SEGMENT}){0,9})$`);
const GLOB_SEGMENT = String.raw`(?:\*\*(?=/|$)|(?!\.{1,2}(?:/|$))(?:[A-Za-z0-9._@+?-]|\*(?!\*))+)`;
export const GLOB_PATTERN = new RegExp(String.raw`^(?=.{1,200}$)${GLOB_SEGMENT}(?:/${GLOB_SEGMENT}){0,9}$`);

export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export const AUTO_MERGE_CATEGORIES = ["renovate:patch", "renovate:minor-dev", "lint-fix"] as const;
export const NOTIFICATION_MODES = ["push", "digest", "none"] as const;
export const PREVIEW_KINDS = ["url", "artifact", "screenshots", "gif", "api-docs"] as const;
export const AGENT_BRANCH_PREFIX = "factory/";

/** Always immutable to agents, whatever the file says (ADR-0013). */
export const IMMUTABLE_BASELINE = [".github/**", "factory.yaml", "CODEOWNERS", "docs/CODEOWNERS"] as const;

const slug = z.string().regex(PRODUCT_PATTERN, {
  error: "must be 2–31 characters: lowercase letters and digits, starting with a letter, single hyphens between runs",
});

const branch = z
  .string()
  .regex(BRANCH_PATTERN, {
    error:
      "must be a branch name: 1–100 characters of [A-Za-z0-9._/-], not starting with - or /, not ending with / or .lock, without // or ..",
  })
  .refine((b) => !b.toLowerCase().startsWith(AGENT_BRANCH_PREFIX), {
    error: `must not start with ${AGENT_BRANCH_PREFIX}: that prefix is reserved for agent branches`,
  });

const repoPath = z.string().regex(REPO_PATH_PATTERN, {
  error: "must be a repo path: '.' or 1–10 '/'-separated segments of [A-Za-z0-9._@+-], no '.' or '..' segments, at most 200 characters",
});

const glob = z.string().regex(GLOB_PATTERN, {
  error:
    "must be a glob: 1–10 '/'-separated segments of [A-Za-z0-9._@+-*?] or exactly '**', no '.' or '..' segments, no {} [] or ! syntax, at most 200 characters",
});

const money = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, { error: "must have at most 2 decimal places" });

function uniqueItems<T>(what: string) {
  return (items: T[], ctx: z.RefinementCtx<T[]>) => {
    const seen = new Set<T>();
    items.forEach((item, i) => {
      if (seen.has(item)) ctx.addIssue({ code: "custom", path: [i], message: `duplicate ${what}` });
      seen.add(item);
    });
  };
}

function entryCount(min: number, max: number, what: string) {
  return (r: Record<string, unknown>, ctx: z.RefinementCtx<Record<string, unknown>>) => {
    const n = Object.keys(r).length;
    if (n < min || n > max) ctx.addIssue({ code: "custom", message: `must have ${min}–${max} ${what}, found ${n}` });
  };
}

const owner = z.strictObject({
  login: z.string().regex(LOGIN_PATTERN, {
    error: "must be a GitHub login: 1–39 letters, digits or single hyphens, not starting or ending with a hyphen",
  }),
  id: z.number().int().positive().meta({ description: "Immutable GitHub user ID; the trust gate compares this, never the login." }),
});

const environment = z.strictObject({
  gcpProject: z.string().regex(GCP_PROJECT_PATTERN, { error: "must be a GCP project ID" }),
  region: z.string().regex(REGION_PATTERN, { error: "must be a GCP region such as us-central1" }),
});

const openConfig = z.looseObject({}).meta({ description: "Validated by the profile's or adapter's own schema." });

const part = z.strictObject({
  path: repoPath,
  profile: z.string().regex(DESCRIPTOR_ID_PATTERN, { error: "must be a profile id" }),
  config: openConfig.optional(),
  preview: z
    .strictObject({
      enabled: z.boolean().default(true),
      bindings: z
        .record(z.string().regex(BINDING_INPUT_PATTERN, { error: "must be an input name (A-Z, 0-9, _; starting with a letter)" }), z.string())
        .superRefine(entryCount(0, 20, "bindings"))
        .meta({ maxProperties: 20 })
        .default(() => ({})),
    })
    .prefault({}),
  release: z
    .array(
      z.strictObject({
        adapter: z.string().regex(DESCRIPTOR_ID_PATTERN, { error: "must be an adapter id" }),
        config: openConfig.optional(),
      }),
    )
    .max(10)
    .default(() => []),
  dependsOn: z
    .array(z.string().regex(PART_NAME_PATTERN, { error: "must be a part name" }))
    .max(20)
    .superRefine(uniqueItems("part name"))
    .default(() => []),
});

const partName = z.string().regex(PART_NAME_PATTERN, {
  error: "must be a part name: 1–20 lowercase letters and digits, starting with a letter, no hyphens",
});

export const factoryYamlShape = z
  .strictObject({
    version: z.literal(1),
    product: slug,
    owners: z.array(owner).min(1).max(10),
    autonomy: z.enum(AUTONOMY_LEVELS).default("L1"),
    project: slug.nullable().default(null),
    git: z
      .strictObject({
        defaultBranch: branch.default("main"),
        baseBranch: branch.optional().meta({ description: "Where factory PRs target. Defaults to defaultBranch." }),
      })
      .prefault({}),
    environments: z
      .record(z.string().regex(ENVIRONMENT_NAME_PATTERN, { error: "must be an environment name: 1–16 lowercase letters and digits, starting with a letter" }), environment)
      .superRefine(entryCount(0, 8, "environments"))
      .meta({ maxProperties: 8 })
      .default(() => ({})),
    parts: z
      .record(partName, part)
      .superRefine(entryCount(1, 20, "parts"))
      .meta({ minProperties: 1, maxProperties: 20 }),
    limits: z
      .strictObject({
        maxConcurrentBuilders: z.number().int().min(1).max(5).default(1),
        perRunUsd: money(0.01, 50).default(4),
        perRunMinutes: z.number().int().min(5).max(180).default(45),
        dailyUsd: money(0.01, 200).default(20),
      })
      .prefault({}),
    guardrails: z
      .strictObject({
        loadBearing: z.array(glob).max(100).default(() => []),
        immutable: z.array(glob).max(100).default(() => []),
      })
      .prefault({}),
    autoMerge: z
      .array(z.enum(AUTO_MERGE_CATEGORIES))
      .superRefine(uniqueItems("category"))
      .default(() => []),
    notifications: z
      .strictObject({
        blocking: z.enum(NOTIFICATION_MODES).default("push"),
        previews: z.enum(NOTIFICATION_MODES).default("digest"),
        routine: z.enum(NOTIFICATION_MODES).default("digest"),
      })
      .prefault({}),
  })
  .meta({
    title: "globalhost factory.yaml v1",
    description: "Shape only; the validator (`globalhost validate`) is authoritative. Spec: docs/FACTORY-YAML.md.",
  });

export type FactoryYamlShape = z.output<typeof factoryYamlShape>;

export const FACTORY_SCHEMA_ID = "https://raw.githubusercontent.com/anlinguist/globalhost/main/schemas/factory.schema.json";

/** JSON Schema (draft 2020-12, input shape) for editors; committed as schemas/factory.schema.json. */
export function factoryJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(factoryYamlShape, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return { $schema, $id: FACTORY_SCHEMA_ID, ...rest };
}
