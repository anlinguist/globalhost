# ADR-0002: Database — Neon for new Postgres; keep Firestore where it exists

- Status: proposed
- Date: 2026-10-27

## Context

The brief asks Neon (per-PR branching) vs Cloud SQL (DB per PR on a shared dev instance). Constraints learned since: GCP budget is **$25/month** for the whole factory, and every existing product (numu-know, Readefine, Biblia Sacra) uses **Firebase/Firestore**, not Postgres.

- Cloud SQL's smallest shared-core instance costs roughly $8–10/month running 24/7 *before* storage and backups — ~40% of the budget for one dev instance, plus a separate prod instance. No instant branching; per-PR DBs need create/drop + seed scripts.
- Neon: free tier, scale-to-zero, copy-on-write branches per PR in seconds (including seeded data), point-in-time restore on paid tiers.

## Decision

1. **New Postgres-backed products and parts use Neon.** Per-PR branch from a seeded `dev` branch; prod on its own Neon project. Upgrade prod to a paid plan when a product earns it (for longer PITR history).
2. **Existing Firestore products stay on Firestore.** No migration for its own sake.
   - Previews use a separate `<product>-dev` Firebase project seeded with fixture data (never prod).
   - CI integration tests use the Firestore emulator (ephemeral per run).
   - Per-PR isolation only when a PR changes data shape: a named Firestore database `pr-<n>` in the dev project, dropped on close.
3. Cloud SQL stays available as a Pulumi component for a product that needs GCP-private networking or compliance, but isn't the default.

## Consequences

- One more vendor (Neon), accepted for cost and branching.
- The `service` profile supports `db: neon | firestore | none`; core doesn't care.
- Prod PITR: Neon (paid) for Postgres; Firestore PITR (7-day) + scheduled exports to GCS for Firestore prods. Enabling these for numu-know prod is a Phase 4 task.
