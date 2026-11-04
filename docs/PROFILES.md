# globalhost — Profiles

> Status: draft for approval (2026-10-27).

> **Profiles describe the shape of a deliverable, not its stack** (ADR-0010). They define how a part is verified, what its preview gives the owner, and how it reaches users. Database, auth, email, analytics and other vendor choices belong to the product (`docs/product/STACK.md`) and to integrations. Any facet below can be overridden per part in `factory.yaml`, and `profile: custom` lets a repo supply its own `verify`/`preview`/`release` commands.

A **part** is a deployable unit in a product repo (`apps/web`, `apps/extension`, `apps/api`, or the whole repo for adopted single-app repos). Every part has exactly one **profile**. A profile packages everything type-specific so the core never branches on project type.

## 1. Profile interface

Profiles are npm packages under `packages/profiles/<id>` exporting a `Profile` object. The core discovers them by id from `factory.yaml`.

```ts
// packages/core/src/profile.ts (abridged; the file is authoritative)
export interface RepoSnapshot {
  readonly files: readonly string[];                   // repo-relative file paths at one commit
  readFile(path: string): Promise<string | undefined>;
}
export interface Detection<Cfg> { confidence: number; evidence: string[]; suggestedConfig: Cfg }
export interface PartCtx<Cfg, D> { name: string; path: string; config: Cfg; detection: D }

export interface Profile<Cfg = unknown, D extends Detection<Cfg> = Detection<Cfg>> extends ProfileDescriptor {
  id: string;                         // "web-app", "chrome-extension", "service", "npm-package", ...
  version: string;
  configSchema: z.ZodType<Cfg>;       // validates parts[].config in factory.yaml (synchronous)

  /** Assessment: how confident is it that this path is this kind of part? */
  detect(repo: RepoSnapshot, path: string): Promise<D>;  // profiles may extend Detection with typed facts

  /** Files rendered into the product repo by `globalhost install` (and new-project template). */
  scaffold: {
    template?: TemplateRef;           // full template for new projects
    install: FileTemplate[];          // CI workflow fragments, test harness config, Renovate rules
  };

  /** Mounted into every agent run touching this part. */
  skills: SkillRef[];                 // e.g. { name: "web-app", path: "skills/web-app" }

  /** The `limited` network environment agent runs use (ADR-0011); package registries are always allowed. */
  environment: { name: string; allowedHosts: string[] };

  /** Repo-specific text for the run's task message: commands to install, verify and smoke-test.
   *  Built from owner-authored config and fixed strings only, never repo content. */
  guidance(part: PartCtx<Cfg, D>): string;

  /** Optional. Tool versions the part asks for (e.g. node from .nvmrc), read from a snapshot of the run's BASE
   *  commit (a review's base branch tip), as core's generic Toolchain: tool id → canonical range + source file + check/install commands. */
  toolchain?(repo: RepoSnapshot, part: { name: string; path: string }): Promise<Toolchain>;

  /** Verification contributed to CI; fails closed. */
  verify: {
    steps(part: PartCtx<Cfg, D>): VerifyStep[];  // {id, run, env?, needs?, artifacts?, image?}
    localSubset: string[];            // step ids the runner executes before publishing
  };

  /** What the owner receives on the PR. */
  preview: PreviewContract<Cfg>;

  /** How it reaches users. Adapter is chosen per part in factory.yaml. */
  release: {
    defaultAdapter: string;
    allowedAdapters: string[];
  };

  guardrails: {
    immutable: string[];              // part-relative globs agents can never change; the validator scopes them to the part
    checks: Guardrail[];              // evaluated checks below; Phase 2, empty until then
  };

  // Later: infra?: { component: string; inputs: (cfg: Cfg, env: Env) => Record<string, unknown> };
}

export interface PreviewContract<Cfg> {
  kinds: Array<"url" | "artifact" | "screenshots" | "gif" | "api-docs">;
  /** Output names other parts can bind to (composite previews), e.g. ["url"] */
  outputs: string[];
  /** Input names this part accepts as bindings, e.g. ["API_URL"]; factory.yaml may bind only these */
  inputs: string[];
  build(ctx: PreviewCtx<Cfg>): Promise<PreviewResult>;   // runs in PR workflow
  teardown(ctx: PreviewCtx<Cfg>): Promise<void>;
}

export interface Guardrail {
  id: string;                          // "manifest-permissions", "openapi-breaking", ...
  paths: string[];                     // globs that trigger evaluation
  evaluate(diff: DiffCtx): Promise<GuardrailResult>; // pass | needsApproval(reason) | fail(reason)
  approvalLabel: string;               // e.g. "approved:permissions"
}
```

**How the runner uses a profile for a run** (P1-06): build the registry the same way the CLI does (`createRegistry<Profile, DeployAdapter>([webApp, ...], [...])`), take the part from the validated `factory.yaml`, then `profile = registry.profile(part.profile)`, `detection = await profile.detect(snapshot, part.path)`, and `profile.guidance({ name, path, config: part.config, detection })` → `startRun({ guidance })`. The session's environment is `profile.environment`, and `profile.skills` are mounted. Detection facts that reach guidance come from fixed sets (framework, package manager), so the guidance carries no untrusted repo text.

**Toolchain versions** (P2-01): the dispatcher passes the parts' `profile.toolchain` hooks to the runner as one resolver (`profileToolchain`, parts merged in `factory.yaml` order; the first part wins a disagreement, with a note). The runner calls it on a snapshot of the run's base commit read from the object store (`gitSnapshot`: regular files only, 512 KiB cap, UTF-8): the builder's start commit, a resumed builder's stored base, and for a review the base branch tip (the PR's pull_request CI runs on the merge ref, base tip + head, so that's the config it used, and the head can't steer it by choosing an old branch point). Never a PR head, so a PR can't change the versions it is built or reviewed with. Range syntaxes are converted into core's canonical grammar (`packages/core/src/toolchain.ts`: `20`, `>=20 <23`, `20 || 22`); anything else (aliases like `lts/*`, expressions, junk, ranges no version satisfies such as `^20 ^21`) is skipped with a fixed-text note. The task message states each version, how to check it and how to get it in the sandbox (registry-only installs); the agent reports what it used in `report.json` `toolchain`, and the harness records `run.json` `toolchain` and a problem line per mismatch (a note only: no escalation). Shared detectors live in `packages/profiles/toolchains` (`@globalhost/profile-toolchains`, not a profile): `detectNode`, which follows what the product's CI runs: `actions/setup-node` `node-version` in `globalhost-ci.yml` when it is a version (exact or partial, not a range) → that step's `node-version-file` (its path is repo content, so it's named only as the workflow in the source and notes) → `.nvmrc`/`.node-version` in the part dir then parents → `package.json` `engines.node`, `detectBun` (`packageManager: bun@x.y.z` → `engines.bun`), `detectPython` (`.python-version` → `pyproject.toml` `requires-python`) and `detectUv` (`[tool.uv] required-version` → `uv.toml`). `web-app` uses node, plus bun when the part's package manager is bun; a Python profile adds python and uv. Version sources the harness doesn't read (`volta.node`, `.tool-versions`) are noted. Before a Python profile uses the python/uv hints: `uv python install` downloads from GitHub releases (not a package registry) and the sandbox may have no pip, so the profile must allow those hosts or ship uv and Python in its environment.

Rules:
- **Core never imports a profile.** Enforced by a lint rule (`no-restricted-imports`) in `packages/core`.
- Verify steps are rendered into a profile-specific reusable CI job; the core CI job (`typecheck`, `lint`, `test`, `guardrails`) is identical for all repos.
- Guardrails run as a single `globalhost/guardrails` check. `needsApproval` adds `needs:owner-approval` and fails the check until the owner applies the guardrail's `approved:*` label on the current head SHA (approval is invalidated by new pushes).
- Adding a profile = adding a package + registering its id. No core change. Example future profiles: `npm-package` (release: `npm` adapter with provenance), `cli`, `mobile-expo` (Bibliacra RN), `static-site`.

## 2. Preview contract & composite repos

Each part declares preview inputs/outputs. The PR preview workflow builds a DAG from `factory.yaml` `dependsOn` and resolves bindings:

```yaml
parts:
  api:       { path: apps/api, profile: service }
  extension:
    path: apps/extension
    profile: chrome-extension
    dependsOn: [api]
    preview:
      bindings: { API_URL: "${parts.api.preview.url}" }
```

Order: `api` preview deploys first → its `url` output is injected as `API_URL` when building the extension zip → the PR gets one comment with the API URL, the API reference, the extension zip, and screenshots of the extension running against *that* API.

A binding is exactly one `${parts.<part>.preview.<output>}` reference. Its key must be one of the consumer profile's `inputs`, the referenced part must be in `dependsOn`, and the output must be declared by the provider's profile (FACTORY-YAML.md §3.5.1). Validation uses the profile's descriptor fields (`configSchema`, `preview.kinds/outputs/inputs`, `release.allowedAdapters`), which `Profile` extends.

Only parts whose paths (or dependencies' paths) changed are rebuilt; unchanged providers reuse the dev deployment's outputs.

Artifact hosting for previews:
- **URLs**: `https://<product>-<part>-pr-<n>.globalhost.ai` behind Cloudflare Access (ADR-0007).
- **Screenshots/GIFs**: committed to an orphan branch `globalhost-artifacts` under `pr-<n>/` and linked in the PR comment (renders in GitHub for anyone with repo access; pruned on PR close). Seed data only, so public repos are fine.
- **Build artifacts (zips)**: GitHub Actions artifact (link in comment), retention 14 days.

## 3. Deploy adapters

Release and hosted-preview mechanics are adapters, so a part can keep its existing target.

```ts
export interface DeployAdapter<Cfg = unknown> extends AdapterDescriptor {
  id: string;
  configSchema: z.ZodType<Cfg>;
  capabilities: { preview: boolean; canary: boolean; rollback: boolean; asyncGate: boolean };
  preview?(ctx: PreviewCtx, cfg: Cfg): Promise<PreviewResult>;
  release(ctx: ReleaseCtx, cfg: Cfg): Promise<ReleaseHandle>;
  status(handle: ReleaseHandle): Promise<ReleaseStatus>;   // polled by watcher for async gates
  rollback?(handle: ReleaseHandle): Promise<void>;
}
// ReleaseHandle = { adapter, sha, data: Record<string, string> }: plain JSON recorded on GitHub, no credentials.
// ReleaseStatus = { state: pending | running | succeeded | failed | cancelled | unknown, detail, url? }.
```

Adapters that call cloud APIs take their credentials as an injected provider (`createXAdapter({ accessToken })`); the instance the CLI registers for validation has none.

| Adapter | Use | Notes |
|---|---|---|
| `cloud-run` | factory-managed Cloud Run service (Pulumi component) | canary via traffic split, auto-rollback (P4) |
| `cloud-run-existing` | existing service not in Pulumi | `gcloud run deploy` with the release SA |
| `cloud-build-trigger` | existing Cloud Build trigger on push (numu-know today) | observe-only: waits for build, reports status; zero change to deploy. `globalhost dispatch observe` (ARCHITECTURE §2.7) comments ✅/❌ on the PR and issue and closes the issue once the merged commit is confirmed live on the configured `cloudRun` service, not merely built (ADR-0019; App-opened factory PRs only; only the pushed head commit's PR; polling up to 30 min uses Actions minutes on private repos) |
| `cloud-run-job` | jobs/workers (+ Cloud Scheduler) | |
| `cloudflare-workers` | Workers/Pages | `wrangler deploy` with scoped token |
| `chrome-web-store` | CWS item | upload → trusted testers → publish with staged rollout %; async gate |
| `edge-addons` | Edge Add-ons API | async gate |
| `firefox-amo` | AMO via `web-ext sign` | async gate; listed/unlisted |
| `safari-manual` | Xcode/App Store | produces checklist + artifacts; owner completes |
| `npm` | packages/CLIs | provenance, `next` dist-tag then promote |
| `manual` | anything else | posts a release checklist issue |

A part may list several release targets (e.g. an extension shipping to Chrome, Edge, Firefox). The owner changes targets by telling the factory ("also ship to Firefox"), which results in a PR to `factory.yaml` — never a silent change.

## 4. Initial profiles

### 4.1 `web-app`

| Facet | Definition |
|---|---|
| Detect | `next`, `vite`, `remix`, `astro` deps; `app/`/`pages/`/`src/` with HTML entry; Dockerfile serving HTTP |
| Skill | `skills/web-app`: routing conventions, accessibility checklist, design-system doc usage, how to write Playwright acceptance tests first |
| Verify | `typecheck`, `lint`, unit tests; Playwright e2e against the preview URL (or local `next start` in CI); `toHaveScreenshot` visual regression with baselines in repo, generated in the pinned Playwright container for determinism |
| Preview | `url` + `screenshots` (key routes from config, desktop + mobile viewport) |
| Release | default `cloud-run` (canary: 10% tagged revision → watch error rate 10 min → 100%, else roll back); adopted repos: `cloud-build-trigger` / `cloud-run-existing` |
| Guardrails | `visual-baseline` (baseline image changes need `approved:visual`), `new-dependency`, `env-surface` (new `NEXT_PUBLIC_*`/public env vars need approval), `auth-config` (changes to auth/middleware paths) |
| Data | previews use the dev project's DB/Firestore with seed data |
| Config | `routes` to screenshot, `port`, `previewEnv` (non-secret build/runtime env), `seed` command, `install` (overrides the lockfile-derived install, e.g. `npm ci --legacy-peer-deps` for numu-know); `buildArgs` later |

**v0 (P1-03)** implements detect, the skill, verify (install, typecheck, lint, test, build, Playwright smoke with screenshots), guidance and the preview contract's shape. `preview.build`/`teardown` throw until P1-11. Release allows only `cloud-build-trigger` until `cloud-run` exists. Guardrails: only `immutable` (`.env`, `.env.*`); the checks above arrive in Phase 2.

### 4.2 `chrome-extension` (MV3; multi-store capable)

| Facet | Definition |
|---|---|
| Detect | `manifest.json` with `manifest_version: 3` (or build script emitting one); `chrome/`, `edge/`, `firefox/`, `safari/` build outputs (Readefine) |
| Skill | `skills/chrome-extension`: MV3 service-worker lifecycle, message passing, CSP, storage, cross-browser differences, privacy rules |
| Verify | build per target; Playwright (Chromium, persistent context with `--load-extension`) against `targetSites` from config — live sites read-only, plus locally served fixture snapshots for determinism; bundle secret scan; size budget |
| Preview | `artifact` (zip per target, with API URL bound from composite preview) + `screenshots`/`gif` of the extension on each target site |
| Release | per target adapter: `chrome-web-store` (upload → trusted testers → owner approves → publish with staged rollout %), `edge-addons`, `firefox-amo`, `safari-manual`. Store review is an async gate tracked by the watcher; result notifies owner |
| Guardrails | **`manifest-permissions` (hard):** any diff to `permissions`, `optional_permissions`, `host_permissions`, `optional_host_permissions`, `content_scripts[].matches`, `externally_connectable`, `content_security_policy`, `web_accessible_resources` → `needs:owner-approval` (`approved:permissions`), never auto-merge at any level. **`no-secrets-in-bundle` (fail):** scan built zip for keys/tokens/high-entropy strings; sensitive calls go through a backend part. **`identity-stable` (fail):** `key`, `browser_specific_settings.gecko.id`, store item IDs must not change. **`privacy-telemetry`:** error reporting must be opt-in/scrubbed, use an allowed endpoint, and fit the CSP |
| Config | `targets` (browsers), `targetSites`, `storeItems` (ids per store; non-secret), `rollout` |

### 4.3 `service` (APIs, jobs, workers)

| Facet | Definition |
|---|---|
| Detect | `express`, `@nestjs/core`, `hono`, `fastify`; Dockerfile exposing a port; `openapi.(yaml|json)` |
| Skill | `skills/service`: contract-first changes, expand/contract migrations, idempotent jobs, structured logging + OTel |
| Verify | unit; contract tests against the OpenAPI spec (spec generated or hand-written; responses validated); integration tests against an **ephemeral database** (Neon branch per CI run, or Firestore emulator for Firestore services — ADR-0002) |
| Preview | `url` behind Access + `api-docs` (rendered reference from the PR's spec, e.g. Scalar/Redoc static page served by the preview) |
| Release | `cloud-run` canary; jobs via `cloud-run-job` + Cloud Scheduler; adopted: `cloud-build-trigger`/`cloud-run-existing` |
| Guardrails | **`openapi-breaking`:** `oasdiff breaking` on every PR; breaking → `needs:owner-approval` and the PR must include a "Versioning plan" section (new version path or expand/contract schedule). **`migration-safety`:** destructive DDL (drop/rename/type narrowing) requires approval and a contract phase. **`new-dependency`** |
| Config | `openapi` path, `db` (neon/firestore/none), `jobs[]` with schedules, `healthPath` |

## 5. Profile-agnostic pieces (core)

Every repo, regardless of profile, gets: `globalhost.yml` dispatcher, core CI (typecheck/lint/test/guardrails + zizmor/actionlint), Renovate (grouped, weekly; its PRs always reach the owner, ADR-0015), CodeQL + secret scanning where available, `docs/product/` memory (SPEC.md, DESIGN.md, DECISIONS.md), and seed-data convention (`pnpm seed` against dev only).
