# @globalhost/assess

The onboarding assessment (PLAN P1-08, ONBOARDING Stage 1) behind `globalhost assess <owner/repo>`. Trusted code gathers the facts. The `assessor` role interprets them, builds and tests the repo in its sandbox, and scores what the facts can't decide. Trusted code then composes the onboarding issue.

## Flow

```
globalhost assess owner/repo [--gcp-project <id>] [--asks-file <path>] [--post]
  facts (trusted, read-only)
    GitHub REST     repo, visibility, workflows, contributors, collaborators (needs a token with push access)
    bare clone      every branch: ahead/behind the default branch; credential-shaped files ever committed
    gitleaks        full history of every branch, --redact (skipped, and reported "not run", if not installed)
    snapshot        each registered profile's detect() on the root and two directory levels (stack & parts)
    gcloud          only with --gcp-project: triggers, Cloud Run services, Firestore, SA-key activity
  readiness (facts) + proposed factory.yaml (validated like `globalhost validate`)
  assessor session  bundle of the default branch + facts, repo-derived text fenced as untrusted
  issue body        every ONBOARDING §1 section: harness facts first, then the assessor's notes
  --post            POST /repos/<repo>/issues with the owner's GITHUB_TOKEN
```

The agent gets no GitHub or GCP credential. It returns `assessment.md`, `report.json` (with `readiness`) and, optionally, its own `factory.yaml`.

## The checks

| Check | Module | Output |
|---|---|---|
| Repo, visibility, workflows, people | `checks/github-repo.ts` | `RepoFacts`; a failed optional call is "unavailable (reason)", never an error |
| Branches & flow | `checks/branches.ts` | default branch SHA; other branches with ahead/behind counts and last commit date (30 max) |
| Stack & parts | `checks/stack.ts` | every (path, profile) detection ≥ 0.3; non-overlapping parts ≥ 0.5 proposed, else the best guess flagged low-confidence |
| Secrets | `checks/secrets.ts` | gitleaks findings as file + rule + commit + line; credential-shaped files (tracked or history-only, with the adding commit); GCP SA key files |
| GCP | `checks/gcp.ts` | trigger names/branches/config file, service name/region/URL/image, Firestore databases, and whether each committed SA key is still listed and enabled |

**No secret values, anywhere.** gitleaks runs with `--redact`, and its report parser keeps only file, rule, commit and line. The scanner's stderr is never surfaced. A committed key file is parsed for `client_email` and `private_key_id` only; the key ID is used for the IAM lookup and never written out. The gcloud schemas drop trigger substitutions and service environment variables at parse time.

**Public repos.** The issue gives secret findings as counts and rule names; locations stay in the local `facts.json` (ONBOARDING §8). The assessor is told the same, and gets counts only.

## Readiness

The rubric is ONBOARDING §1's (100 points). For the items below, the score comes from the facts and the assessor can't change it:

| Item | From facts |
|---|---|
| `ci` (5) | 5 with an active GitHub workflow or a pull-request Cloud Build trigger; 0 with neither, but only when GCP was checked |
| `secrets` (10) | 0 on any gitleaks finding; 10 when gitleaks ran clean and no credential-shaped file was ever committed |
| `docs` (5) | 5 with `CLAUDE.md`/`AGENTS.md` at the root |
| `testsExist` (15) | 0 with no test-like files |

The assessor scores everything else, plus any of these the facts left open: `build`, `typecheckLint`, `testsCritical`, `localDev` and `nonProd`, and `testsExist` when tests exist. Its scores are clamped to each item's maximum. An item nobody scored counts as 0 and shows as unscored.

## The proposed factory.yaml

It's built from the facts: product slug from the repo name, owners (the repo's user account, or `--owner login:id`), `autonomy: L1`, the detected parts with their profiles' suggested config, a `dev` environment (`<product>-dev`), and `prod` when `--gcp-project` is given. Release is the existing deploy when the CLI's proposer finds exactly one enabled Cloud Build trigger for the default branch. The file is validated against the registered profiles and adapters, and any errors go into the issue.

The assessor's own `factory.yaml` replaces it only if it validates and keeps the same owners, product and `L1` with no `autoMerge`. That way a hostile README can't talk the agent into proposing a different owner.

## Posting

The issue body is postable as composed. Agent text is sanitized, raw HTML outside code blocks is escaped, unclosed fences are closed, and `<!--` and `@mentions` are neutralized (`asPostable`). Repo-derived names in the harness's tables go through `cell()`. Posting happens only with `--post` after a successful run, or with `--post-from <dir>` for a dry run the owner has reviewed (and maybe edited).

## Outputs (`.globalhost/runs/<run-id>/`)

`assessment.md` (the issue body), `run.json`, `facts.json`, `assessment.json` (readiness, proposal notes, problems), `factory.proposed.yaml`, and the agent's raw `assessment.agent.md`, `report.json` and `factory.agent.yaml`.
