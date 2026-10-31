# ADR-0009: Entire (entire.com) — use the Checkpoints CLI in runners; don't adopt the forge (yet)

- Status: proposed; amended by ADR-0015 (reviewers don't read the builder's session; checkpoints are audit only)
- Date: 2026-10-27

## Context

Entire is a new "git forge for agent-human collaboration" from former GitHub CEO Thomas Dohmke. It launched Feb 2026 with a $60M seed. As of Oct 2026, from its site, docs (`docs.entire.com`) and public repos (`github.com/entireio`):

- **CLI / Checkpoints** (open source, MIT, ~5k★, very active): hooks into git and captures agent sessions (prompts, tool calls, files, token usage) linked to commits. Supports Claude Code, Codex, Cursor, Copilot CLI, and others. Has secret redaction. Checkpoints can be stored in the repo, in another repo, or kept local.
- **Forge:**
  - hosts git repos on a distributed network, or **mirrors GitHub repos** with GitHub as upstream;
  - **Trails** replace PRs (intent + changes across repos + sessions + reviews + CI + approvals, with merge **gates**);
  - CI only via Buildkite/Depot ("public preview");
  - OpenAPI specs exist for git/sessions/trails/webhooks.
- Also: `entire-graph` (precomputed code map for agents), `entire-brain` (repo memory), `git-sync`, Dispatches (markdown summaries of agent work).
- **Gaps for us:** no issue tracker; no GitHub Actions; no documented bot/app identity model; pricing is credit-based with no published tiers; no Chrome Web Store/Cloud Build integrations; it's very young. Whether writes to a mirror sync back to GitHub isn't documented.

## Decision

1. **GitHub stays the control plane.** Entire can't yet replace issues, Actions, Apps, rulesets, or the integrations the factory depends on. Moving would mean rebuilding the loop on a forge in preview.
2. **Adopt the Entire CLI inside the runner** (Phase 2, behind a flag) to capture each agent session as a checkpoint linked to its commits:
   - ~~The reviewer role gets the builder's reasoning~~. Superseded by ADR-0015: reviewers judge from evidence, not the builder's account, which would be an injection channel.
   - It gives provenance and audit for every agent commit, and raw material for the Phase 6 "redirects → skills" loop.
   - Storage: **a separate private repo** (`anlinguist/globalhost-checkpoints`) or local-only, never the product repo. Public product repos (numu-know) must not publish agent transcripts.
3. **Evaluate `entire-graph`** as an agent context tool in Phase 6 evals (measure: tokens per merged PR with vs without).
4. **Revisit the forge** at the start of Phase 3 and Phase 6, or sooner if any trigger is hit:
   - Trails gain an approvals API we can drive from the PWA plus a bot identity model;
   - mirrors document two-way sync;
   - pricing is published and fits the budget.
   The likely first step would be read-only mirroring of one public repo for Entire's review/search features, with GitHub remaining upstream.

## Consequences

Low-cost, reversible adoption of the most mature piece (the open-source CLI). Its schema and storage are documented in Entire's docs. We avoid betting the control plane on a beta forge.
