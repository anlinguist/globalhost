# infra/github-app

Scripts for the factory's GitHub App `globalhost-ai` (PLAN P1-05). Both run directly with Node 24 (type stripping, no build step).

| Script | Does |
|---|---|
| `src/create-app.ts` | Creates the App via the [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) and stores its private key in Secret Manager `globalhost-factory/github-app-key`. The key goes from GitHub's response to `gcloud`'s stdin: never written to disk, never printed. |
| `src/token.ts` | Mints an installation token for one repo with a permission subset (`read`: contents/issues/PRs read; `write`: contents/issues/PRs write). Reads the key from Secret Manager into memory only. |

App permissions (ARCHITECTURE §5.1): contents RW, issues RW, pull requests RW, checks R, actions R, metadata R. No `workflows`, administration, secrets or members. Private App, webhook inactive, no events.

## Owner steps

Prerequisites: `infra/factory` applied (the `github-app-key` secret exists), `gcloud auth login` as the owner, `pnpm i` at the repo root.

```sh
# 1. Create the App. Opens nothing by itself: visit the printed URL while signed in to GitHub as anlinguist.
node infra/github-app/src/create-app.ts
#    → review the permissions on github.com, click "Create GitHub App for anlinguist".
#    → the terminal prints the app id, slug and install URL.

# 2. Install it on anlinguist/numu-know only:
#    open https://github.com/apps/<slug>/installations/new → "Only select repositories" → numu-know.

# 3. Optional hygiene: in the App's settings, delete the client secret the manifest flow created
#    (the factory never uses OAuth), and confirm the webhook is inactive.
```

Record the app id (not a secret) as a repo variable where the dispatcher needs it (P1-07).

### Recovery

If creation succeeded but storing the key failed, the conversion code can't be reused. In the App's settings, generate a new private key, then:

```sh
gcloud secrets versions add github-app-key --project=globalhost-factory --data-file="$HOME/Downloads/<file>.pem" \
  && rm -P "$HOME/Downloads/<file>.pem"
```

and delete the unused key in the App's settings.

## P1-05 acceptance checks

`token.ts` runs a command with `GH_TOKEN` set, so the token never reaches the terminal. `APP_ID` is the id printed in step 1.

```sh
T="node infra/github-app/src/token.ts --app-id $APP_ID --repo anlinguist/numu-know"
SHA=$(gh api repos/anlinguist/numu-know/commits/main --jq .sha)

# Read token: reads work...
$T --access read -- gh api repos/anlinguist/numu-know/contents/README.md --jq .name
# ...and it can't push at all (expect HTTP 403)
$T --access read -- gh api -X POST repos/anlinguist/numu-know/git/refs -f ref=refs/heads/factory/ac-probe -f sha="$SHA"

# Write token: can create a factory/* branch...
$T --access write -- gh api -X POST repos/anlinguist/numu-know/git/refs -f ref=refs/heads/factory/ac-probe -f sha="$SHA"
# ...but can't touch workflows (expect HTTP 403: the App has no `workflows` permission)
$T --access write -- gh api -X PUT repos/anlinguist/numu-know/contents/.github/workflows/ac-probe.yml \
  -f message="ac probe" -f branch=factory/ac-probe -f content="$(printf 'on: push\n' | base64)"
# Clean up the probe branch
$T --access write -- gh api -X DELETE repos/anlinguist/numu-know/git/refs/heads/factory/ac-probe
```
