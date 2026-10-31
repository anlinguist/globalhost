# globalhost — `factory.yaml` v1 specification

> Status: accepted spec for P1-02 (2026-10-29). Rationale for the security-relevant rules is in ADR-0013.

Every product repo declares one `factory.yaml` at its root. It tells the factory who the owners are, what the deployable parts are, how each is verified, previewed and released, and what agents may and may not do. This document is the contract that `packages/core` implements and `globalhost validate` checks. The annotated example is in ONBOARDING.md §4.

## 1. Trust and loading

- **Only the default branch counts.** Consumers (dispatcher, publisher, preview, release) load `factory.yaml` from the repo's default branch as of the triggering event, never from a PR head or a `factory/*` branch. A PR that edits `factory.yaml` changes nothing until the owner merges it.
- **Agents can't edit it.** `factory.yaml` is always immutable to agents (§3.8).
- **The parser assumes hostile input anyway.** A stranger can open a PR that contains a crafted `factory.yaml`, and CI may validate it. Parsing and validation are bounded and side-effect free (§4).

## 2. Top level

| Key | Type | Required | Default | Rules |
|---|---|---|---|---|
| `version` | `1` | yes | — | Exactly the integer `1`. |
| `product` | slug | yes | — | §3.1 |
| `owners` | list of owner | yes | — | §3.2 |
| `autonomy` | `L0`\|`L1`\|`L2`\|`L3` | no | `L1` | ONBOARDING §2 |
| `project` | slug \| `null` | no | `null` | Same rules as `product`; names a manifest in `globalhost/projects/` (ONBOARDING §6.2). That the manifest exists is checked once multi-repo support lands, not in v1. |
| `git` | object | no | see §3.3 | |
| `environments` | map | no | `{}` | §3.4 |
| `parts` | map | yes | — | §3.5 |
| `limits` | object | no | see §3.7 | |
| `guardrails` | object | no | see §3.8 | |
| `autoMerge` | list | no | `[]` | §3.9 |
| `notifications` | object | no | see §3.10 | |

Every object is **closed**: an unknown key is an error, at every level, so a typo (`dependOn`) fails loudly instead of silently doing nothing. The one exception is a part's `config`, which is closed or open as its profile's schema decides.

## 3. Fields

### 3.1 `product`

`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 2–31 characters: lowercase, starts with a letter, single hyphens between alphanumeric runs, no trailing hyphen.

It is used in preview hostnames (`<product>-<part>-pr-<n>.globalhost.ai`, `<product>-<part>-dev.globalhost.ai`) and GCP resource names. Uniqueness across products is checked by factory config, not by v1.

### 3.2 `owners`

```yaml
owners:
  - { login: anlinguist, id: 47403803 }
```

- 1–10 entries. Each has `login` (GitHub login syntax: 1–39 alphanumerics or single hyphens, not starting or ending with a hyphen) and `id` (positive integer GitHub user ID).
- `id` values are unique, and `login` values are unique case-insensitively.
- **The trust gate compares the event sender's `id`**, never the login. Logins can be renamed and later claimed by someone else, and IDs can't (ADR-0013). `login` is for display, CODEOWNERS rendering and a mismatch warning.

### 3.3 `git`

| Key | Default | Rules |
|---|---|---|
| `defaultBranch` | `main` | Branch name (below). Must not start with `factory/`. |
| `baseBranch` | value of `defaultBranch` | Branch name; where factory PRs target. Must not start with `factory/`. |

**Branch name:** 1–100 characters from `[A-Za-z0-9._/-]`. It must not start with `-` or `/`, end with `/` or `.lock`, or contain `//` or `..`.

Neither branch may start with `factory/` (compared ignoring case). The publisher can push to `factory/*`, so a default branch there would let an agent's push reach prod without a merge (CLAUDE.md #6).

There is no `branchPrefix`. Agent branches are always `factory/…`, because the publisher may push only there (CLAUDE.md #3). A `branchPrefix` key gets a dedicated error explaining this, not just "unknown key".

### 3.4 `environments`

A map from environment name (`^[a-z][a-z0-9]{0,15}$`, at most 8 entries) to `{ gcpProject, region }`, both required:
- `gcpProject`: `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` (GCP project ID syntax).
- `region`: `^[a-z]+-[a-z]+[0-9]+$` (e.g. `us-central1`).

Rules:
- **No environment may share `prod`'s `gcpProject`.** Previews and dev data must never touch prod (ONBOARDING Stage 3).
- **`dev` is required if any part has a hosted preview** (its profile's preview kinds include `url` and its preview is enabled). Hosted previews deploy into the dev project (ARCHITECTURE §2.6).

### 3.5 `parts`

A map from part name to part, 1–20 entries.

**Part name:** `^[a-z][a-z0-9]{0,19}$`. Lowercase alphanumerics, up to 20 characters, **no hyphens**. A hyphen would make preview hostnames ambiguous: product `a-b` part `c` and product `a` part `b-c` would both be `a-b-c-pr-1`, so one product's preview could answer for another's (ADR-0013). With these limits, `<product>-<part>-pr-<n>` fits a 63-character DNS label for any `n` up to 7 digits.

**Part:**

| Key | Required | Default | Rules |
|---|---|---|---|
| `path` | yes | — | Repo path (§3.6) to the part's root; `.` for single-app repos. |
| `profile` | yes | — | A registered profile id (§5). |
| `config` | no | `{}` | Validated by the profile's `configSchema`. |
| `preview` | no | `{ enabled: true, bindings: {} }` | §3.5.1 |
| `release` | no | `[]` | 0–10 targets, §3.5.2 |
| `dependsOn` | no | `[]` | 0–20 unique part names. |

**Part rules:**
- **No path overlap.** Part paths must be distinct, and no part's path may contain another's (`.` with `apps/web`, or `apps` with `apps/web`). Paths are compared ignoring case, so `Apps` and `apps` overlap too (one directory on a case-insensitive checkout). Each file belongs to at most one part, so change detection and path policy have one answer.
- **`dependsOn`** entries must name declared parts, must not name the part itself, and must be acyclic across the whole file. A cycle error names the cycle, e.g. `web → api → web`.

#### 3.5.1 `preview`

```yaml
preview:
  enabled: true
  bindings: { API_URL: "${parts.api.preview.url}" }
```

- `enabled`: boolean, default `true`.
- `bindings`: 0–20 entries, from an input name (`^[A-Z][A-Z0-9_]{0,63}$`) to exactly one reference of the form `${parts.<part>.preview.<output>}`. The whole string must be that one reference: no surrounding text, no second reference, no other `${…}` forms. That makes a binding a pure reference that can't splice text into a build. `<part>` is a part name and `<output>` matches `^[a-z][a-zA-Z0-9]{0,39}$`; anything else is `binding_syntax`.

**Binding rules:**
- The key must be one of the inputs declared by the consuming part's profile (`preview.inputs`). Bindings can't set arbitrary environment variables such as `NODE_OPTIONS`.
- `<part>` must be listed in this part's `dependsOn`.
- `<part>`'s preview must be enabled, and `<output>` must be one of its profile's `preview.outputs`.
- Bindings on a part whose preview is disabled are an error, since they could never apply.

#### 3.5.2 `release`

```yaml
release:
  - adapter: cloud-build-trigger
    config: { project: numu-know, trigger: numu-know-main }   # trigger name or id; region defaults to global
```

Each target is `{ adapter, config }`:
- `adapter` must be a registered adapter and must be in the part's profile's `release.allowedAdapters`.
- `config` defaults to `{}` and is validated by the adapter's `configSchema`.

### 3.6 Repo paths and globs

**Repo path** (part `path`):
- `.`, or 1–10 `/`-separated segments, each matching `[A-Za-z0-9._@+-]+`;
- no `.` or `..` segment, no leading or trailing `/`, no backslash;
- at most 200 characters.

**Glob** (guardrail patterns) is a deliberately small dialect, so the validator, publisher and CI all agree on what a pattern matches:
- **Syntax:**
  - Same segment rules as a repo path, except a segment may contain `*` and `?`, or be exactly `**`.
  - No `{}`, `[]`, `!` negation, or extglob.
  - At most 200 characters, and at most 100 patterns per list.
- **Matching (implemented with the path policy):**
  - Matched against repo-relative paths.
  - `*` matches any run of characters within one segment, including a leading dot.
  - `?` matches one character within one segment.
  - `**` matches zero or more whole segments.
  - A pattern with no wildcard matches exactly that path. To cover a directory, write `dir/**`.
  - **Guardrail matching ignores case**, so `Factory.yaml` or `.GitHub/` can't slip past on a case-insensitive checkout. Ignoring case only ever adds protection.

### 3.7 `limits`

| Key | Default | Range |
|---|---|---|
| `maxConcurrentBuilders` | 1 | integer 1–5 |
| `perRunUsd` | 4 | 0.01–50, at most 2 decimals |
| `perRunMinutes` | 45 | integer 5–180 |
| `dailyUsd` | 20 | 0.01–200, at most 2 decimals |

`perRunUsd` must not exceed `dailyUsd`. The ceilings exist to catch typos (`400` for `4.00`). At run time, the factory-wide caps in factory config also apply, and the lower limit wins.

### 3.8 `guardrails`

| Key | Default | Meaning |
|---|---|---|
| `loadBearing` | `[]` | Globs. Any agent change touching them gets `needs:owner-approval`. |
| `immutable` | `[]` | Globs. The publisher rejects any agent bundle touching them. |

**The immutable baseline always applies.** These four patterns are added to `immutable` whether or not they are listed:
- `.github/**`
- `factory.yaml`
- `CODEOWNERS`
- `docs/CODEOWNERS`

The validator's normalized output contains the union. A product can add protection but can't remove the baseline. There's no negation syntax, and listing a baseline pattern is allowed but redundant.

Listing the same pattern in both `loadBearing` and `immutable` is an error, since the two lists mean contradictory things. The check uses the merged `immutable` list (so a baseline pattern in `loadBearing` is an error too) and ignores case, like guardrail matching. Exact repeats within one list are dropped from the normalized output.

### 3.9 `autoMerge`

> ADR-0015 supersedes this list with a merge policy and an `escalate` list of extra triggers. Until that work lands, the key keeps the rules below.

A list of unique categories from a closed set:
- `renovate:patch`
- `renovate:minor-dev`
- `lint-fix`

**It must be empty unless `autonomy` is `L3`** (ONBOARDING §2). Even at L3, the guardrail and `loadBearing` exclusions of ONBOARDING §2 still apply at run time.

### 3.10 `notifications`

Keys `blocking` (default `push`), `previews` (default `digest`) and `routine` (default `digest`), each `push` | `digest` | `none`.

## 4. Parsing

`parseFactoryYaml(text)` turns text into a plain value, or returns errors. It never runs code, never resolves anything external, and takes bounded time and memory:

- **Size:** at most 64 KiB of UTF-8 (the CLI checks the file size before reading). A leading BOM is ignored. Invalid UTF-8 is an error.
- **One document**, YAML 1.2 core schema (`yes`/`no`/`on` are strings, not booleans).
- **No anchors, aliases or explicit tags (`!…`) at all.** That rules out alias-expansion ("billion laughs") attacks and custom types. `<<` is an ordinary key, so the closed objects reject it.
- **Duplicate keys** are an error at any level.
- **Nesting depth** of at most 32. Exceeding it is an error, not a crash.
- **Map keys** must be strings (`invalid_type` otherwise). The parser builds plain values from the YAML AST itself and defines every key as an own data property, so a `__proto__` key never changes an object's prototype; a test pins this. Part, environment and binding names also have to match their name patterns, which rejects `__proto__`, `constructor` and similar. (zod's records skip a `__proto__` key silently, so the validator checks these names on the raw value as well.)
- **Numbers** must be finite (`.inf`, `.nan` and overflowing literals are `invalid_value` at their path).
- **`yaml_*` errors** have the empty path (the whole document) and give a line and column in the message. Each `yaml_*` code is reported at most once, so a hostile file can't produce unbounded output.

## 5. Validation

`validateFactoryConfig(value, registry)` returns either `{ ok: true, config }` with defaults applied and the immutable baseline merged, or `{ ok: false, errors }`. It is synchronous, deterministic and has no I/O, so profile and adapter schemas must be synchronous zod schemas.

**Two stages:**
1. **Shape:** the closed zod schema for every field above. If this stage has errors, they are returned and stage 2 doesn't run.
2. **Cross-field and registry checks:**
   - profiles and adapters are known and allowed;
   - part and adapter configs pass their schemas;
   - paths don't overlap, dependencies resolve and are acyclic;
   - bindings, environments, `autoMerge` and limits rules hold.

   This stage reports every error it finds, not just the first.

**Registry.** Core never imports profiles or adapters (CLAUDE.md #1). The caller passes a registry:

```ts
// packages/core — P1-02 defines these; P1-03's Profile and DeployAdapter extend them.
export interface ProfileDescriptor {
  id: string;
  configSchema: z.ZodType;
  preview: { kinds: PreviewKind[]; outputs: string[]; inputs: string[] };
  release: { allowedAdapters: string[] };
}
export interface AdapterDescriptor {
  id: string;
  configSchema: z.ZodType;
}
// Generic so the runner gets full Profile/DeployAdapter objects back; the validator needs only descriptors.
export interface Registry<P extends ProfileDescriptor = ProfileDescriptor, A extends AdapterDescriptor = AdapterDescriptor> {
  profile(id: string): P | undefined;
  adapter(id: string): A | undefined;
  profiles(): P[];
  adapters(): A[];
}
export function createRegistry<P, A>(profiles: P[], adapters: A[]): Registry<P, A>; // rejects duplicate ids
```

Profile and adapter ids match `^[a-z][a-z0-9-]{0,39}$`, in the registry (`createRegistry` throws otherwise) and in `factory.yaml` (`invalid_value` in stage 1). Profile `preview.inputs` and `preview.outputs` must match the binding input and output patterns (§3.5.1). Core re-exports its `z`, so descriptors build their schemas with the same zod version the validator runs.

**Errors** are `{ path, code, message }`:
- `path` is a dotted path with indexes (`parts.web.dependsOn[0]`). A key that isn't a plain identifier is JSON-quoted (`parts["Web-App"]`).
- Errors are sorted by path, then by code (plain string order), then by message. In stage 1, a value that breaks two rules of one field is reported once per code.
- Messages quote at most 80 characters of any value from the file.

Codes are stable, because `--json` consumers depend on them:

| Code | When |
|---|---|
| `yaml_too_large` | over 64 KiB |
| `yaml_encoding` | invalid UTF-8 |
| `yaml_syntax` | YAML parse error |
| `yaml_multi_document` | more than one document |
| `yaml_duplicate_key` | duplicate key |
| `yaml_alias` | anchor or alias |
| `yaml_tag` | explicit tag |
| `yaml_too_deep` | nesting over 32 |
| `invalid_type` | wrong type |
| `invalid_value` | right type, fails a rule (pattern, range, enum, length) |
| `unknown_key` | key not in a closed object |
| `missing_key` | required key absent |
| `branch_prefix_fixed` | `git.branchPrefix` present |
| `unknown_profile` / `unknown_adapter` | id not in the registry |
| `adapter_not_allowed` | adapter not in the profile's `allowedAdapters` |
| `profile_config` / `adapter_config` | `config` fails the profile's or adapter's schema; nested issues are reported at their own paths with this code |
| `path_overlap` | part paths equal or nested |
| `dependency_unknown` / `dependency_self` / `dependency_cycle` | `dependsOn` problems |
| `binding_syntax` | value isn't exactly one `${parts.<part>.preview.<output>}` |
| `binding_input_unknown` | key not in the profile's `preview.inputs` |
| `binding_not_dependency` | referenced part not in `dependsOn` |
| `binding_output_unknown` | output not in the provider profile's `preview.outputs` |
| `binding_preview_disabled` | provider's or consumer's preview is disabled |
| `env_dev_missing` | hosted preview without a `dev` environment |
| `env_shares_prod_project` | a non-prod environment uses prod's `gcpProject` |
| `automerge_requires_l3` | `autoMerge` non-empty below L3 |
| `guardrail_conflict` | same pattern in `loadBearing` and `immutable` |
| `limits_inconsistent` | `perRunUsd` > `dailyUsd` |
| `owner_duplicate` | repeated owner `id` or `login` |

## 6. JSON Schema

`schemas/factory.schema.json` is generated from the zod schema with zod's `toJSONSchema` (draft 2020-12, input shape, so keys that have defaults are optional).
- Its `$id` is `https://raw.githubusercontent.com/anlinguist/globalhost/main/schemas/factory.schema.json`. Product repos can reference it for editor completion with `# yaml-language-server: $schema=<that URL>`.
- It covers shape only. Part `config` is an open object, and none of the stage-2 rules are expressible in it. The validator is authoritative.
- It is committed, and a test compares it with freshly generated output, so it can't drift. Regenerate it with `pnpm schema:update` (`pnpm test -u` doesn't reach vitest through turbo; `pnpm --filter @globalhost/core test -u` also regenerates the valid fixtures' recorded output).

## 7. CLI: `globalhost validate [path]`

- `path` defaults to `./factory.yaml`.
- The file must be a regular file. It is opened once, its size is checked with `fstat` before reading, and reads stop at 64 KiB + 1 byte.
- **Output:**
  - Human output is one line per error, `path: message`, followed by a summary line. A document-level error (empty path) uses the file name as its path.
  - All text from the file passes through `printable()`, so control characters can't rewrite the terminal.
  - With `--json`, output is `{"ok": bool, "errors": [{path, code, message}]}` on stdout.
- **Exit codes:**
  - `0`: valid.
  - `1`: invalid, including a file over 64 KiB (`yaml_too_large`, decided from `fstat` without reading).
  - `2`: usage error, or the file is missing, unreadable or not a regular file.
- **Registry:** the CLI builds it from the profile and adapter packages, so the CLI (not core) is where they are imported. `run(argv, deps)` takes the registry (and the file-system calls) as injectable dependencies, so `defaultDeps()` registers the profile and adapter packages (P1-03: `web-app`, `cloud-build-trigger`) and tests pass fakes.

## 8. Versioning

- `version: 1` covers this document.
- Adding an optional key with a default that keeps existing behavior is **additive**: the version stays 1. Older validators reject the new key, which is fine, because the validator ships with the factory and the factory updates first.
- Any change that makes a valid file invalid, or changes what a valid file means, bumps the version. The validator then accepts both versions for one phase and migrates old files with a factory PR.

## 9. Out of scope for v1

These come later as additive keys:
- **Integrations** (ADR-0010).
- **Profile facet overrides beyond `config`, `preview` and `release`.** `profile: custom` (supplying verify, preview and release commands) is a profile with its own `configSchema`, not core schema.
- **Cross-file checks:**
  - that `project` exists;
  - that `product` is unique;
  - that `owners` are a subset of the factory's owners;
  - limits against factory-wide caps.
