# ADR-0013: `factory.yaml` v1 — validation contract

- Status: accepted; amended by ADR-0015 (`autoMerge` can't take effect)
- Date: 2026-10-29

## Context

ONBOARDING §4 had one example file and a few rules. Before P1-02 could be built, several open questions had to be settled:
- **Profile and adapter checks before profiles exist.** Part config, adapter config and bindings are checked against profile and adapter schemas, but profiles only arrive in P1-03, and core may not import them.
- **The real numu-know file can't be a public fixture.** It would contain real trigger names and GCP projects, and this repo is public.
- **How strict to be**, and which policy rules belong in the schema.
- **Hidden trust weaknesses** in the draft schema: owners were identified by login, preview hostnames could collide, and agents' branch prefix and immutable paths were configurable.

## Decision

The full contract is `docs/FACTORY-YAML.md`. The decisions that carry weight:

1. **Registry injection.** Core validates against a `Registry` of profile and adapter *descriptors* passed in by the caller (the CLI). Core never imports a profile. P1-02 builds the validator and tests it with fake descriptors. P1-03's real `Profile` and `DeployAdapter` extend those descriptors, and P1-03's acceptance criteria include validating the numu-know-shaped example with the real `web-app` profile and `cloud-build-trigger` adapter.
2. **Public fixtures use placeholders.** The real numu-know `factory.yaml` is written by the assessment (P1-08) and lands in numu-know's own repo (P1-09).
3. **Strict by default.** Every object is closed, `version` must be `1`, and only `version`, `product`, `owners` and `parts` are required. Everything else has a default. The validator reports every error it finds, not just the first.
4. **Owners are GitHub user IDs, not logins.** A login can be renamed and then registered by someone else, who would inherit owner trust. The trust gate compares `sender.id` against `owners[].id`, and the login is for display only. This changes ARCHITECTURE §2.3.
5. **Part names have no hyphens.** With hyphens, `<product>-<part>-pr-<n>` is ambiguous across products: `a-b`+`c` and `a`+`b-c` give the same host. Products may keep hyphens. Parsing a hostname from the right is then unambiguous, and the lengths are capped so the hostname always fits one 63-character DNS label.
6. **The agent branch prefix is fixed at `factory/`.** The publisher's push rule (CLAUDE.md #3) and the dispatcher's PR checks assume it, so making it configurable would only create ways to break them.
7. **The immutable baseline can't be removed.** `.github/**`, `factory.yaml`, `CODEOWNERS` and `docs/CODEOWNERS` are always immutable to agents, whatever the file says. The glob dialect has no negation.
8. **Policy rules live in the schema** where a file could encode an unsafe state:
   - `autoMerge` requires L3;
   - no environment may share prod's GCP project;
   - hosted previews need a `dev` environment;
   - a binding key must be an input the profile declares, so a binding can't set `NODE_OPTIONS` and similar.
9. **A small glob dialect, with case-insensitive guardrail matching.** One dialect avoids matcher disagreements between the validator, publisher and CI. Ignoring case can only add protection.
10. **Hardened parsing.** Size cap, one document, no anchors, aliases or tags, no duplicate keys, a depth cap, and pattern-checked map keys. A hostile PR's `factory.yaml` can't exhaust memory or smuggle types. (CI validates PR heads, even though only the default branch's file is trusted.)

## Consequences

- **Owner IDs.** `globalhost install` writes owners with their IDs, looked up from the login via the GitHub API at install time.
- **Exact matching for exact paths.** The ONBOARDING example's `loadBearing` entry `lib/firebase*` still works. Patterns written as bare directory names won't match the directory's contents; they need `dir/**`.
- **The CLI's `validate` is not useful on real files until P1-03** registers the first profile and adapter.
- **New schema features** are additive optional keys (version stays 1) or a version bump with a migration PR (FACTORY-YAML §8).
