#!/usr/bin/env bash
# One-time GCP setup for .github/workflows/security-audit.yml (ADR-0012).
# Owner-run (it changes IAM in globalhost-factory). Safe to re-run: existing resources are kept.
# Port to Pulumi with the rest of the factory infra in P1-04.
set -euo pipefail

PROJECT="${PROJECT:-globalhost-factory}"
REGION="${REGION:-us-central1}"
REPO="anlinguist/globalhost"
REPO_OWNER_ID="47403803"   # github.com/anlinguist; pins the provider against owner-name reuse
REPO_ID="1437394155"       # anlinguist/globalhost; pins against repo delete-and-recreate
POOL="github"
PROVIDER="github-actions"
BUCKET="${BUCKET:-${PROJECT}-audit-reports}"
AUDITOR="globalhost-auditor"
PUBLISHER="globalhost-audit-publisher"

g() { gcloud --project="$PROJECT" --quiet "$@"; }
exists() { "$@" >/dev/null 2>&1; }

NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
g services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com

# Workload Identity Federation: only this repo, only main.
exists g iam workload-identity-pools describe "$POOL" --location=global ||
  g iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
# create-oidc on first run, update-oidc after, so changes to the mapping or condition always apply.
provider_verb=create-oidc
exists g iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" &&
  provider_verb=update-oidc
g iam workload-identity-pools providers "$provider_verb" "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.job_workflow_ref,attribute.environment=assertion.environment" \
    --attribute-condition="assertion.repository_owner_id=='${REPO_OWNER_ID}' && assertion.repository_id=='${REPO_ID}' && assertion.repository=='${REPO}' && assertion.ref=='refs/heads/main'"
POOL_ID="projects/${NUMBER}/locations/global/workloadIdentityPools/${POOL}"

# Private report bucket: no public access, reports deleted after 180 days.
exists gcloud storage buckets describe "gs://${BUCKET}" ||
  gcloud storage buckets create "gs://${BUCKET}" --project="$PROJECT" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
LIFECYCLE="$(mktemp)"
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":180}}]}' > "$LIFECYCLE"
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE"
rm -f "$LIFECYCLE"

# Secrets: created empty; the owner adds the values (below).
# (The audit authenticates to Anthropic with Workload Identity Federation, so there's no Anthropic key.)
exists g secrets describe globalhost-ops-issues-token ||
  g secrets create globalhost-ops-issues-token --replication-policy=automatic

# Service accounts, each usable only from its own GitHub environment. Bound on the mapped `environment`
# claim rather than `sub`: this repo uses GitHub's immutable subjects
# (repo:anlinguist@47403803/globalhost@1437394155:environment:<env>), and the provider condition above
# already pins owner, repo and ref.
for sa in "$AUDITOR" "$PUBLISHER"; do
  exists g iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" ||
    g iam service-accounts create "$sa"
done
bind_env() { # <sa> <github environment>
  g iam service-accounts add-iam-policy-binding "${1}@${PROJECT}.iam.gserviceaccount.com" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.environment/${2}" >/dev/null
}
bind_env "$AUDITOR" security-audit
bind_env "$PUBLISHER" security-audit-publish

# The bucket policy has conditional bindings, so unconditional ones must say --condition=None.
# Bucket layout: globalhost/runs/<run>/ is written by the auditor; globalhost/published/latest (the
# next run's prior) only by the publisher, so a run can't choose what later runs treat as prior.
OBJ="projects/_/buckets/${BUCKET}/objects"
# auditor: read reports; create objects only under globalhost/runs/ (no delete or overwrite). No secrets.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${AUDITOR}@${PROJECT}.iam.gserviceaccount.com" --role=roles/storage.objectViewer \
  --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${AUDITOR}@${PROJECT}.iam.gserviceaccount.com" --role=roles/storage.objectCreator \
  --condition="title=runs-prefix-only,expression=resource.name.startsWith(\"${OBJ}/globalhost/runs/\")" >/dev/null
# Drop the unconditioned create grant from the first version of this script, if present.
gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${AUDITOR}@${PROJECT}.iam.gserviceaccount.com" --role=roles/storage.objectCreator \
  --condition=None >/dev/null 2>&1 || true
# publisher: write (and overwrite) only the published/latest pointer.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${PUBLISHER}@${PROJECT}.iam.gserviceaccount.com" --role=roles/storage.objectUser \
  --condition="title=latest-pointer-only,expression=resource.name == \"${OBJ}/globalhost/published/latest\"" >/dev/null
# publisher: read reports and the globalhost-ops issues token. Nothing else.
g secrets add-iam-policy-binding globalhost-ops-issues-token \
  --member="serviceAccount:${PUBLISHER}@${PROJECT}.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${PUBLISHER}@${PROJECT}.iam.gserviceaccount.com" --role=roles/storage.objectViewer \
  --condition=None >/dev/null

cat <<OUT

Done. Set these GitHub repository variables on ${REPO} (Settings → Secrets and variables → Actions → Variables):
  GCP_PROJECT_ID     ${PROJECT}
  GCP_WIF_PROVIDER   ${POOL_ID}/providers/${PROVIDER}
  GCP_AUDITOR_SA     ${AUDITOR}@${PROJECT}.iam.gserviceaccount.com
  GCP_PUBLISHER_SA   ${PUBLISHER}@${PROJECT}.iam.gserviceaccount.com
  AUDIT_BUCKET       ${BUCKET}

Then add the ops-repo token (waits for a hidden paste; no trailing newline):
  printf 'globalhost-ops token: '; read -rs V; echo; printf %s "\$V" | gcloud secrets versions add globalhost-ops-issues-token --project=${PROJECT} --data-file=-; unset V
      # fine-grained PAT: repository anlinguist/globalhost-ops only, Issues: read and write, expiry ≤ 1 year

Anthropic side (Console → Settings → Workload identity → Connect workload → GitHub Actions), see ADR-0012,
then set repo variables ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_FEDERATION_RULE_ID,
ANTHROPIC_SERVICE_ACCOUNT_ID, ANTHROPIC_WORKSPACE_ID.
OUT
