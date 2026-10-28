# ADR-0004: Runner auth & billing — API key from the linked Console org, funded by the Max $200/month credit

- Status: accepted (credit terms verified 2026-10-27; P0-05). The runner host question moved to ADR-0011.
- Date: 2026-10-27

## Facts (verified against Anthropic support articles and the owner's billing page)

- Owner is on **Max 20x**, so the credit is **$200/month**, linked to Console org **"Andrew's Individual Org"** since 2026-10-11. The next credit lands **2026-11-10**, so the factory's budget month runs from the 10th to the 10th.
- **Covered:** any Claude model via the Claude API (Messages + **Message Batches**), Console Playground, **Claude Managed Agents**, **Claude Agent SDK**, and **`claude -p` run with an API key from the linked org**.
- **Not covered:**
  - `claude -p`/Agent SDK while signed in with the plan (draws on subscription limits instead);
  - **runs started by the Claude Code GitHub Action** (counted as Claude Code usage);
  - interactive Claude Code (terminal/IDE/desktop/web);
  - Bedrock/Vertex/Foundry.
- Credits **don't roll over**, are used **before purchased credits**, and are **shared by every API key in the linked org**.
- When they run out: with no purchased credits or auto-reload, **API requests stop** until the next credit. Nothing is charged to the Claude plan.
- Workspace spend limits in the Console limit spend per project/person.
- Interactive Claude Code under Max is still the right tool for owner-driven steering. That usage comes from plan limits, not the credit.

## Decision

1. **Unattended runs authenticate with API keys from the linked org.** Never a subscription OAuth token in CI/Cloud Run. **Don't use the Claude Code GitHub Action** (`anthropics/claude-code-action`): its usage isn't covered by the credit. Our runner calls the Agent SDK directly.
2. **Keep auto-reload off and don't buy credits.** Running out then stops the factory for the rest of the cycle instead of billing. This is the hard cap.
3. Because the balance is shared org-wide, partition it with **Console workspaces + spend limits**:
   - `globalhost-runners` — $150/cycle (builder, planner, reviewer, fixer, triage)
   - `globalhost-chat` — $20/cycle (factory chat agent, Phase 3)
   - `personal` — $30/cycle (other projects using keys in this org), so side projects can't starve the factory or the reverse.
4. Factory-side caps on top (defaults): $4/run, 45 min/run, $15/day across all repos, 1 concurrent builder per repo, 2 globally. The daily cap stops a bad day from draining the cycle; the remaining budget is visible via `globalhost budget`.
5. Use the **Batch API** (50% cheaper, asynchronous) for non-interactive single-shot jobs: assessment summaries, triage classification, doc refresh, eval grading. Agentic multi-turn runs stay on the regular API.
6. Model per role (configurable in factory config): the most capable model for planner/reviewer and complex builds; a cheaper model for mechanical work (Renovate, lint fixes, triage). Prompt caching for skills and product docs.
7. Spare credit late in the cycle (it doesn't roll over) can run low-priority queues: evals, doc refreshes, test-coverage improvements. Never anything that skips a gate. (Phase 6)

## Runner host

Decided separately in ADR-0011 (Managed Agents first, Cloud Run Job as fallback, gated on spike P1-00). This ADR covers auth and billing only; both runner options use an API key from the linked org.
