// The proposed factory.yaml (ONBOARDING §1): built from the facts, then parsed and validated exactly as
// `globalhost validate` would. The assessor may propose its own version; that one is accepted only if it
// validates and keeps the harness's owners, product and autonomy, so a hostile repo can't talk the agent into
// proposing a different owner.
import { parseFactoryYaml, validateFactoryConfig, type FactoryConfig, type Profile, type Registry } from "@globalhost/core";
import { stringify } from "yaml";
import type { GcpFacts } from "./checks/gcp.js";
import type { PartFinding } from "./checks/stack.js";
import type { AssessmentFacts } from "./facts.js";

export interface Owner {
  login: string;
  id: number;
}

export interface ReleaseProposal {
  adapter: string;
  config: Record<string, unknown>;
}

/**
 * How to keep a part's existing deploy, for the adapters the caller knows (the CLI names them; this module
 * doesn't). Returns undefined when the facts don't show which deploy to keep.
 */
export type ReleaseProposer = (ctx: { profile: Profile; part: PartFinding; gcp: GcpFacts | undefined; repo: string; defaultBranch: string }) => ReleaseProposal | undefined;

export interface ProposalInput {
  facts: AssessmentFacts;
  profiles: readonly Profile[];
  registry: Registry;
  /** Defaults to the repo's owner account when that's a user. */
  owners?: Owner[];
  proposeRelease?: ReleaseProposer;
}

export interface Proposal {
  text: string;
  owners: Owner[];
  product: string;
  /** Validation errors; empty when the file passes `globalhost validate`. */
  errors: string[];
  /** Things the owner has to fill in or confirm. */
  notes: string[];
}

const DEFAULT_REGION = "us-central1";

/** A factory.yaml product slug from a repo name: lowercase, single hyphens, 2–31 characters. */
export function productSlug(repoName: string): string {
  let s = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "");
  s = s.slice(0, 31).replace(/-+$/, "");
  return s.length >= 2 ? s : `app${s}`.slice(0, 31);
}

/** A part name from its path and profile: lowercase alphanumerics, starting with a letter, ≤ 20 characters. */
export function partName(path: string, profileId: string, taken: ReadonlySet<string>): string {
  const source = path === "." ? (profileId.split("-")[0] ?? "app") : (path.split("/").pop() ?? "app");
  let base = source.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 18);
  if (!base) base = "part";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

function devProject(product: string): string {
  return `${product.slice(0, 26).replace(/-+$/, "")}-dev`;
}

export function proposeFactoryYaml(input: ProposalInput): Proposal {
  const { facts } = input;
  const notes: string[] = [];
  const product = productSlug(facts.github.repo.split("/")[1] ?? facts.github.repo);
  let owners = input.owners;
  if (!owners?.length) {
    owners = [{ login: facts.github.owner.login, id: facts.github.owner.id }];
    if (facts.github.owner.type !== "User") notes.push(`The repo belongs to the ${facts.github.owner.type.toLowerCase()} ${facts.github.owner.login}; replace owners with the people who direct the factory (by user ID).`);
  }

  const byId = new Map(input.profiles.map((p) => [p.id, p]));
  const region = (facts.gcp?.services.ok ? facts.gcp.services.items.find((s) => s.region)?.region : undefined) ?? DEFAULT_REGION;
  const parts: Record<string, unknown> = {};
  const taken = new Set<string>();
  for (const f of facts.stack.proposed) {
    const profile = byId.get(f.profile);
    if (!profile) continue;
    const name = partName(f.path, f.profile, taken);
    taken.add(name);
    const release = input.proposeRelease?.({ profile, part: f, gcp: facts.gcp, repo: facts.github.repo, defaultBranch: facts.github.defaultBranch });
    if (!release) notes.push(`parts.${name}.release is empty: no existing deploy was identified${facts.gcp ? "" : " (pass --gcp-project to look for Cloud Build triggers)"}.`);
    parts[name] = { path: f.path, profile: f.profile, config: f.suggestedConfig, ...(release ? { release: [release] } : {}) };
  }
  if (facts.stack.lowConfidence) notes.push("No part was detected with confidence ≥ 0.5; the part below is a best guess for the owner to confirm.");

  const environments: Record<string, unknown> = { dev: { gcpProject: devProject(product), region } };
  if (facts.gcp) environments.prod = { gcpProject: facts.gcp.project, region };
  else notes.push("environments.prod is omitted: pass --gcp-project to record the production project.");
  notes.push(`environments.dev names ${devProject(product)}, which doesn't exist yet; previews need it (ONBOARDING Stage 3).`);

  const value = {
    version: 1,
    product,
    owners,
    autonomy: "L1",
    git: { defaultBranch: facts.github.defaultBranch },
    environments,
    parts,
    guardrails: { loadBearing: [], immutable: [] },
  };
  const text = [
    "# factory.yaml proposed by `globalhost assess`; review it before `globalhost install` commits it.",
    "# Spec: docs/FACTORY-YAML.md in the factory repo.",
    stringify(value, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
  const checked = checkFactoryYaml(text, input.registry);
  return { text, owners, product, errors: checked.ok ? [] : checked.errors, notes };
}

export function checkFactoryYaml(text: string, registry: Registry): { ok: true; config: FactoryConfig } | { ok: false; errors: string[] } {
  const parsed = parseFactoryYaml(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`) };
  const result = validateFactoryConfig(parsed.value, registry);
  if (!result.ok) return { ok: false, errors: result.errors.map((e) => `${e.path || "(root)"}: ${e.message}`) };
  return { ok: true, config: result.config };
}

/** The assessor's factory.yaml, accepted only if it validates and keeps what the harness decides. */
export function checkAgentFactoryYaml(text: string, registry: Registry, proposal: Proposal): { ok: true } | { ok: false; errors: string[] } {
  const checked = checkFactoryYaml(text, registry);
  if (!checked.ok) return checked;
  const c = checked.config;
  const errors: string[] = [];
  const want = new Set(proposal.owners.map((o) => `${o.login.toLowerCase()}#${o.id}`));
  const got = new Set(c.owners.map((o) => `${o.login.toLowerCase()}#${o.id}`));
  if (want.size !== got.size || [...want].some((o) => !got.has(o))) errors.push("owners differ from the harness's proposal");
  if (c.product !== proposal.product) errors.push("product differs from the harness's proposal");
  if (c.autonomy !== "L1") errors.push(`autonomy must be L1 for onboarding, not ${c.autonomy}`);
  if (c.autoMerge.length > 0) errors.push("autoMerge must be empty for onboarding");
  return errors.length ? { ok: false, errors } : { ok: true };
}
