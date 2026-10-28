# ADR-0003: Chat surface — PWA on Cloudflare at globalhost.ai, acting as the owner via GitHub user tokens

- Status: proposed
- Date: 2026-10-27

## Context

The owner wants a phone-first chat agent with push notifications and approve/redirect/discard actions, every action mapping to a GitHub operation. Options: custom PWA, Slack/Telegram/Discord bot, GitHub mobile only, Claude's own apps.

One subtle requirement: the dispatcher only trusts events whose `sender` is the owner. If the PWA acted through the bot App, its labels would come from `globalhost-ai[bot]` and would not count as approval.

## Decision

- **Phases 1–2 (no build):** use GitHub mobile notifications + labels/comments directly. Interactive steering sessions can use Claude Code on web/mobile under the Max subscription (interactive use is fine).
- **Phase 3:** a PWA at `app.globalhost.ai`:
  - Hosting: Cloudflare Pages + a Worker API (free tier), behind Cloudflare Access (same policy as previews). No GCP cost.
  - Auth to GitHub: **GitHub App user-to-server tokens** (OAuth via the App), so approve/redirect/merge happen *as the owner* and the normal trust gate applies.
  - Push: Web Push (VAPID) — works on iOS for installed home-screen PWAs (iOS 16.4+) and on Android.
  - Inbox: built from GitHub search queries (`label:factory:planned`, `needs:owner-approval`, preview comments) plus watcher events; no database of record. A Workers KV cache for push subscriptions and digest scheduling only.
  - Chat agent: Claude via API key (counts against the monthly credit); tools = GitHub ops, preview links, Sentry read, Pulumi stack status. Stateless: conversation context is reconstructed from the linked issue/PR.
- Tiered notifications: blocking → immediate push; previews → daily digest; routine → weekly digest.

## Consequences

Slack/Telegram rejected: another account to secure, weaker rich previews, and messages there aren't GitHub operations. The PWA is a convenience layer; GitHub always works as the fallback.
