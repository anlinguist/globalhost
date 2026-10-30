# P1-00 spike: Managed Agents as runner

This spike is throwaway (ADR-0011, PLAN P1-00), so it's not a workspace package. Delete this directory when the P1-06 harness lands.

It runs numu-know#10 ("CSP blocks audio") on Managed Agents and measures ADR-0011's six go/no-go criteria. The results go into ADR-0011 as numbers only.

## Auth: keyless (ADR-0014)

The script never sees an API key:
1. It mints a Google identity token for `sa:globalhost-spike`, which has no GCP roles, by calling the IAM Credentials `generateIdToken` API with the owner's gcloud login. This needs only `roles/iam.serviceAccountOpenIdTokenCreator` on that one account, not `serviceAccountTokenCreator`.
2. Federation rule `globalhost-p1-00-spike` exchanges that token for a ~10-minute Anthropic token.
3. That token is for Console service account `p1-00-spike`, in workspace `globalhost-runners`.

Set these before running. They're identifiers, not secrets:

```
export ANTHROPIC_ORGANIZATION_ID=45e249d6-b067-453a-9f41-e04920f328e1
export ANTHROPIC_FEDERATION_RULE_ID=fdrl_012ojuq8fuyZ5kbbLmWyvJpe
export ANTHROPIC_SERVICE_ACCOUNT_ID=svac_01MWWgxCqyzXuyL2VGM6GdqW
export ANTHROPIC_WORKSPACE_ID=wrkspc_01Raz9sB141voAYYUvQGEP5V
```

## Run

```
pnpm install --ignore-workspace --frozen-lockfile
node spike.mjs check     # token exchange only
node spike.mjs setup     # limited-network environment + agent (IDs saved in .out/state.json)
node spike.mjs run       # criteria 2, 3, 4: build + smoke in the sandbox, egress probe, bundle round trip ($5 cap)
node spike.mjs resume    # criterion 5: owner follow-up on the same session; prices the delta
node spike.mjs cold      # criterion 5 baseline: the same end state from a cold session ($5 cap)
node spike.mjs loop      # criterion 6: a looping session must stop at its $1 budget
node spike.mjs cleanup   # delete the sessions and environment, archive the agent
```

Criterion 1 (whether the session runtime fee and tokens draw on the monthly credit) is read off the Console usage and billing pages after the runs.

**Isolation:**
- The repo goes in as a git bundle through the Files API, so the sandbox gets no GitHub token and no GitHub egress.
- Networking is `limited`: package registries only, no extra hosts.
- The web tools are off.

**After the spike, the owner deletes:**
- federation rule `globalhost-p1-00-spike`;
- Console service account `p1-00-spike`;
- `sa:globalhost-spike`: `gcloud iam service-accounts delete globalhost-spike@globalhost-factory.iam.gserviceaccount.com --project globalhost-factory`.
