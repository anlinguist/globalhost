// Profile and DeployAdapter contracts (docs/PROFILES.md §1–§3). Core defines the shapes; profiles and adapters
// live in their own packages and are handed to core through a Registry (CLAUDE.md #1). Nothing here may name a
// framework, manifest or API format.
import type { z } from "zod";
import type { AdapterDescriptor, PreviewKind, ProfileDescriptor } from "./factory-yaml/registry.js";
import type { Toolchain } from "./toolchain.js";

/** A read-only view of a repo at one commit. Detection reads only through this, so it never touches a disk. */
export interface RepoSnapshot {
  /** Every file (not directory) in the repo, as repo-relative POSIX paths without a leading "./", e.g. "app/page.tsx". */
  readonly files: readonly string[];
  /** Text of a repo-relative file, or undefined when it doesn't exist or isn't readable as text. */
  readFile(path: string): Promise<string | undefined>;
}

/** What `detect()` found. Evidence is for humans (assessment reports) and may quote repo file names. */
export interface Detection<Cfg = unknown> {
  /** 0..1. The assessment proposes the profile with the highest confidence; below 0.5 it asks the owner. */
  confidence: number;
  evidence: string[];
  /** A starting `parts.<name>.config` for `factory.yaml`; it must pass the profile's configSchema. */
  suggestedConfig: Cfg;
}

/** The part a profile is acting on: its `factory.yaml` name and path, its parsed config and what detect() found. */
export interface PartCtx<Cfg = unknown, D extends Detection<Cfg> = Detection<Cfg>> {
  name: string;
  /** Repo-relative part path; "." for the repo root. */
  path: string;
  config: Cfg;
  detection: D;
}

/** A skill directory in the factory repo (containing SKILL.md) mounted into agent runs. */
export interface SkillRef {
  name: string;
  /** Factory-repo-relative directory, e.g. "skills/web-app". */
  path: string;
}

export interface TemplateRef {
  /** Factory-repo-relative directory under templates/. */
  path: string;
}

export interface FileTemplate {
  /** Destination, relative to the part path. */
  to: string;
  /** Source, factory-repo-relative. */
  from: string;
}

export interface VerifyStep {
  id: string;
  /** Shell command, run from the part path. */
  run: string;
  /** Extra environment for the command; non-secret values only (they come from committed config). */
  env?: Record<string, string>;
  /** Step ids that must succeed first. */
  needs?: string[];
  /** Part-relative paths kept as CI artifacts or run outputs. */
  artifacts?: string[];
  /** Container image (pinned by digest) when the step can't run on the default image. */
  image?: string;
}

/** The network environment agent runs for this profile use (ADR-0011: one `limited` environment per profile). */
export interface EnvironmentSpec {
  name: string;
  /** Hosts reachable beyond the package registries, which every environment allows. */
  allowedHosts: string[];
}

export interface PreviewCtx<Cfg = unknown> {
  product: string;
  part: string;
  path: string;
  prNumber: number;
  headSha: string;
  config: Cfg;
  /** Resolved `preview.bindings`: input name → provider output value. */
  bindings: Record<string, string>;
}

export interface PreviewResult {
  /** Values for the profile's declared `preview.outputs`, e.g. { url: "https://…" }. */
  outputs: Record<string, string>;
  artifacts: Array<{ kind: PreviewKind; name: string; location: string }>;
}

export interface PreviewContract<Cfg = unknown> {
  kinds: PreviewKind[];
  outputs: string[];
  inputs: string[];
  build(ctx: PreviewCtx<Cfg>): Promise<PreviewResult>;
  teardown(ctx: PreviewCtx<Cfg>): Promise<void>;
}

export interface DiffCtx {
  /** Changed files, repo-relative. */
  files: string[];
  readBase(path: string): Promise<string | undefined>;
  readHead(path: string): Promise<string | undefined>;
}

export type GuardrailResult = { kind: "pass" } | { kind: "needsApproval"; reason: string } | { kind: "fail"; reason: string };

export interface Guardrail {
  id: string;
  /** Globs (FACTORY-YAML glob syntax) that trigger evaluation. */
  paths: string[];
  evaluate(diff: DiffCtx): Promise<GuardrailResult>;
  /** e.g. "approved:visual". */
  approvalLabel: string;
}

export interface Profile<Cfg = unknown, D extends Detection<Cfg> = Detection<Cfg>> extends ProfileDescriptor {
  /** e.g. "web-app". */
  id: string;
  version: string;
  /** Validates `parts.<name>.config`. Synchronous (FACTORY-YAML §5). */
  configSchema: z.ZodType<Cfg>;

  /** How confident is it that `path` (repo-relative, "." for root) is this kind of part? */
  detect(repo: RepoSnapshot, path: string): Promise<D>;

  /** Files rendered into the product repo by `globalhost install`. */
  scaffold: { template?: TemplateRef; install: FileTemplate[] };

  /** Mounted into every agent run touching this part. */
  skills: SkillRef[];

  /** Network environment for agent runs on this part. */
  environment: EnvironmentSpec;

  /**
   * Text the runner adds to the task message for a run on this part: how to install, verify and smoke-test it.
   * It must be built from the config (owner-authored) and fixed strings only, never from repo content.
   */
  guidance(part: PartCtx<Cfg, D>): string;

  /**
   * Tool versions the part asks for, read through `repo`, which callers give at the run's base commit (never a PR
   * head). Repo files are untrusted: parse strictly into the canonical range grammar (toolchain.ts) and put only
   * fixed text in notes. Optional: a profile without it imposes no versions.
   */
  toolchain?(repo: RepoSnapshot, part: { name: string; path: string }): Promise<Toolchain>;

  /** Verification contributed to CI and run locally before publishing; fails closed. */
  verify: {
    steps(part: PartCtx<Cfg, D>): VerifyStep[];
    /** Step ids the runner executes before publishing. */
    localSubset: string[];
  };

  /** What the owner receives on the PR. */
  preview: PreviewContract<Cfg>;

  /** How it reaches users. The adapter is chosen per part in factory.yaml. */
  release: { defaultAdapter: string; allowedAdapters: string[] };

  guardrails: {
    /**
     * Globs (relative to the part path) agents may never change, added to `factory.yaml` `guardrails.immutable`
     * and the baseline. The only guardrail enforced in Phase 1.
     */
    immutable: string[];
    /** Evaluated checks; deferred to Phase 2, so Phase-1 profiles leave this empty. */
    checks: Guardrail[];
  };
}

export interface ReleaseCtx {
  product: string;
  part: string;
  /** The merge commit on the default branch being released (40 hex chars). */
  sha: string;
  environment: { gcpProject: string; region: string };
}

/**
 * Identifies one release so the watcher can poll it later. Plain JSON: it is recorded on the PR or issue
 * (CLAUDE.md #2), so it may hold no credentials.
 */
export interface ReleaseHandle {
  adapter: string;
  sha: string;
  data: Record<string, string>;
}

export const RELEASE_STATES = ["pending", "running", "succeeded", "failed", "cancelled", "unknown"] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

export interface ReleaseStatus {
  state: ReleaseState;
  /** Short human-readable detail, e.g. the provider's own status name. */
  detail: string;
  /** Link to the provider's page for this release, when known. */
  url?: string;
}

/**
 * Why a finished release isn't confirmed live. `no-artifact`: the release produced nothing deployable. `not-updated`:
 * what serves isn't this commit. `split-traffic`: serving is shared with something else. `not-ready`: the new
 * version exists but isn't ready to serve.
 */
export const RELEASE_NOT_LIVE_REASONS = ["no-artifact", "not-updated", "split-traffic", "not-ready"] as const;
export type ReleaseNotLiveReason = (typeof RELEASE_NOT_LIVE_REASONS)[number];

/**
 * Whether the release's commit is what prod serves now. A succeeded build is not a deploy: only `live` lets a caller
 * say "deployed". `unverifiable`: the adapter wasn't told what to check. `not-live` with `final: false` may change by
 * waiting (a rollout in progress); with `final: true` it won't.
 */
export type ReleaseLiveness =
  | { state: "live"; via: "digest" | "tag" }
  | { state: "not-live"; reason: ReleaseNotLiveReason; final: boolean }
  | { state: "unverifiable"; reason: "no-target" };

export interface DeployAdapter<Cfg = unknown> extends AdapterDescriptor {
  id: string;
  configSchema: z.ZodType<Cfg>;
  capabilities: { preview: boolean; canary: boolean; rollback: boolean; asyncGate: boolean };
  preview?(ctx: PreviewCtx, cfg: Cfg): Promise<PreviewResult>;
  release(ctx: ReleaseCtx, cfg: Cfg): Promise<ReleaseHandle>;
  /** Polled by the watcher. */
  status(handle: ReleaseHandle): Promise<ReleaseStatus>;
  rollback?(handle: ReleaseHandle): Promise<void>;
  /**
   * After `status()` says succeeded: whether the release's commit is what prod actually serves. Read-only. A caller
   * never calls a release deployed without `live` from here. Throws on provider errors, so callers fail closed.
   */
  verifyLive?(handle: ReleaseHandle): Promise<ReleaseLiveness>;
}
