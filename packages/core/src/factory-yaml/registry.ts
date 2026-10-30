import type { z } from "zod";
import { BINDING_INPUT_PATTERN, DESCRIPTOR_ID_PATTERN, PREVIEW_KINDS, PREVIEW_OUTPUT_PATTERN } from "./schema.js";

export type PreviewKind = (typeof PREVIEW_KINDS)[number];

/** What the validator needs to know about a profile. P1-03's `Profile` extends it. */
export interface ProfileDescriptor {
  id: string;
  /** Validates `parts.<name>.config`. Must be synchronous. */
  configSchema: z.ZodType;
  preview: { kinds: PreviewKind[]; outputs: string[]; inputs: string[] };
  release: { allowedAdapters: string[] };
}

/** What the validator needs to know about a deploy adapter. P1-03's `DeployAdapter` extends it. */
export interface AdapterDescriptor {
  id: string;
  /** Validates `parts.<name>.release[i].config`. Must be synchronous. */
  configSchema: z.ZodType;
}

export interface Registry {
  profile(id: string): ProfileDescriptor | undefined;
  adapter(id: string): AdapterDescriptor | undefined;
}

function checkId(kind: string, id: unknown): void {
  if (typeof id !== "string" || !DESCRIPTOR_ID_PATTERN.test(id)) {
    throw new Error(`${kind} id ${JSON.stringify(id)} must match ${DESCRIPTOR_ID_PATTERN}`);
  }
}

function checkNames(what: string, names: readonly string[], pattern: RegExp): void {
  for (const name of names) {
    if (!pattern.test(name)) throw new Error(`${what} ${JSON.stringify(name)} must match ${pattern}`);
  }
}

/**
 * Builds the registry the validator checks profile and adapter ids against. Core never imports a profile or
 * adapter (CLAUDE.md #1); the caller (the CLI) passes them in. Throws on duplicate or malformed ids.
 */
export function createRegistry(profiles: readonly ProfileDescriptor[], adapters: readonly AdapterDescriptor[]): Registry {
  const profileMap = new Map<string, ProfileDescriptor>();
  const adapterMap = new Map<string, AdapterDescriptor>();
  for (const p of profiles) {
    checkId("profile", p.id);
    if (profileMap.has(p.id)) throw new Error(`duplicate profile id ${JSON.stringify(p.id)}`);
    checkNames(`profile ${p.id}: preview kind`, p.preview.kinds, new RegExp(`^(?:${PREVIEW_KINDS.join("|")})$`));
    checkNames(`profile ${p.id}: preview output`, p.preview.outputs, PREVIEW_OUTPUT_PATTERN);
    checkNames(`profile ${p.id}: preview input`, p.preview.inputs, BINDING_INPUT_PATTERN);
    checkNames(`profile ${p.id}: allowed adapter`, p.release.allowedAdapters, DESCRIPTOR_ID_PATTERN);
    profileMap.set(p.id, p);
  }
  for (const a of adapters) {
    checkId("adapter", a.id);
    if (adapterMap.has(a.id)) throw new Error(`duplicate adapter id ${JSON.stringify(a.id)}`);
    adapterMap.set(a.id, a);
  }
  return {
    profile: (id) => profileMap.get(id),
    adapter: (id) => adapterMap.get(id),
  };
}
