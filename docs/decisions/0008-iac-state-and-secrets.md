# ADR-0008: Pulumi state in GCS with Cloud KMS secrets; Secret Manager for runtime secrets

- Status: proposed
- Date: 2026-10-27

## Context

The brief mentions Pulumi ESC or encrypted config for secret values. The budget is tight and there's one operator. Pulumi Cloud's individual tier is free, but it's another account and auth surface. ESC adds features we don't need yet.

## Decision

- Pulumi backend: `gs://globalhost-pulumi-state` (project `globalhost-factory`, versioning on). One program per product in `infra/`, plus the factory's own program in `globalhost/infra`. Stacks: `dev`, `prod`, `pr-<n>`, and TTL stacks `tmp-<slug>-<yyyymmdd>`.
- Secrets provider: `gcpkms://projects/globalhost-factory/locations/global/keyRings/pulumi/cryptoKeys/state` (≈$0.06/mo).
- Runtime secrets: GCP Secret Manager in the environment's project. Values are set by the owner (`pulumi config set --secret` → Pulumi creates the secret version, or `gcloud secrets versions add`). Never committed, never set by agents.
- Auth everywhere via WIF; no SA keys.
- TTL stacks carry a `globalhost:expires` tag. A nightly cleanup destroys expired and orphaned `pr-*` stacks (PR closed).

## Consequences

Can move to Pulumi Cloud + ESC later with `pulumi stack export/import`. Since we don't use Pulumi Cloud, review stacks get no hosted UI and the PR comment carries the `pulumi preview` diff.
