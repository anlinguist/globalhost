# @globalhost/runner

The runner harness (PLAN P1-06): it drives one factory role through a Claude Managed Agents session (ADR-0011). It turns the session's outputs into a trusted `run.json`. The dispatcher (P1-07) and `globalhost run` both use it.

## What a run does

1. **Read the inputs.** It reads the repo and issue from GitHub, read-only. Text from anyone who isn't an owner is sanitized and fenced as `<untrusted>` data (ARCHITECTURE §4).
2. **Bundle the repo.** It bare-clones the default branch and bundles it with HEAD set. The bundle goes in through the Files API, so the session gets no GitHub credential and no GitHub egress.
3. **Sync the role's agent.** It creates the role's agent, or a new version of it, from `packages/roles`. The prompts and tool settings are hashed into the agent's metadata, and the session pins that version. The environment is `limited`: package registries only.
4. **Run the session.** It starts the session with a server-enforced USD `budget` and sends the task message. It then waits for the turn to end, and survives dropped event streams: every stop decision is reconciled against the session's event log.
5. **Collect the outputs.** It downloads only the allowlisted outputs, each within a size cap: `report.json`, `plan.md`, `result.bundle` and `*.png`.
   - The agent's report is validated and treated as data.
   - The result bundle is fetched into a bare repo, with no checkout and no hooks. It must carry exactly `refs/heads/factory/issue-<n>`, descending from the base.
6. **Write `run.json`** with the status (`succeeded`, `blocked`, `failed`, `cap_exceeded` or `timeout`), cost, outputs and problems.

A **resume** sends owner feedback to the same session, which keeps its full context. It tops up the budget by `--budget` on top of what's already spent.

## Local runs (`globalhost run`)

Local runs are keyless (ADR-0014). Your gcloud login mints a Google identity token for `sa:globalhost-local`, a service account with no GCP roles. A Console federation rule exchanges that token for a ~10-minute Anthropic token, in workspace `globalhost-runners`.

**One-time setup:**
1. Create the service account and let yourself mint its identity tokens:
   ```
   gcloud iam service-accounts create globalhost-local --project globalhost-factory --display-name "globalhost local runs"
   gcloud iam service-accounts add-iam-policy-binding globalhost-local@globalhost-factory.iam.gserviceaccount.com \
     --project globalhost-factory --member user:<you> --role roles/iam.serviceAccountOpenIdTokenCreator
   gcloud iam service-accounts describe globalhost-local@globalhost-factory.iam.gserviceaccount.com --format 'value(uniqueId)'
   ```
2. Connect it in Console: Connect workload → Google Cloud.
   - Subject: the unique ID. Claim `email`: the SA email.
   - Workspace `globalhost-runners`, scope `workspace:developer`, 600 s.
3. Export the IDs. They're identifiers, not secrets:
   ```
   export GLOBALHOST_LOCAL_SA=globalhost-local@globalhost-factory.iam.gserviceaccount.com
   export ANTHROPIC_ORGANIZATION_ID=… ANTHROPIC_FEDERATION_RULE_ID=… ANTHROPIC_SERVICE_ACCOUNT_ID=… ANTHROPIC_WORKSPACE_ID=…
   ```

**Usage:**
```
pnpm globalhost run anlinguist/numu-know 12 --role planner --budget 2
pnpm globalhost run anlinguist/numu-know 12 --role builder --plan-file .globalhost/runs/<id>/plan.md
pnpm globalhost run --resume sesn_… --feedback "Use the existing Button component instead."
```

Add `--config <factory.yaml>` to give a local run the same profile guidance and network environment the dispatcher would build. The file can be a draft that isn't committed to the product repo yet; its owners are used unless `--owner-id` is given.

**Skills.** Every registered profile's skill directory (`skills/<name>`) is uploaded as a Managed Agents custom skill and pinned, by version, on both role agents. A skill is named by a hash of its files (`globalhost-web-app <hash>`), so an unchanged skill is reused and an edit uploads a new one and bumps the agents' versions. All agents carry all profile skills, so `roles sync`, local runs and the dispatcher produce the same agent definition.

Outputs land in `.globalhost/runs/<run-id>/`, which is gitignored. To look at a builder's work, fetch its bundle into a clone of the product repo:
```
git fetch <out>/result.bundle factory/issue-12:factory/issue-12
```

Nothing is pushed: publishing is the dispatcher's job (P1-07).
