#!/usr/bin/env bash
# One-time GCP setup for .github/workflows/security-audit.yml (ADR-0012).
# Owner-run (it changes IAM in globalhost-factory). Safe to re-run: existing resources are kept.
# Port to Pulumi with the rest of the factory infra in P1-04.
set -euo pipefail

PROJECT="${PROJECT:-globalhost-factory}"
REGION="${REGION:-us-central1}"
REPO="anlinguist/globalhost"
REPO_OWNER_ID="47403803"   # github.com/anlinguist; pins the provider against owner-name reuse
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
exists g iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" ||
  g iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global --workload-identity-pool="$POOL" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.job_workflow_ref" \
    --attribute-condition="assertion.repository_owner_id=='${REPO_OWNER_ID}' && assertion.repository=='${REPO}' && assertion.ref=='refs/heads/main'"
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

# Service accounts, each usable only from its own GitHub environment.
for sa in "$AUDITOR" "$PUBLISHER"; do
  exists g iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" ||
    g iam service-accounts create "$sa"
done
bind_env() { # <sa> <github environment>
  g iam service-accounts add-iam-policy-binding "${1}@${PROJECT}.iam.gserviceaccount.com" \
    --role=roles/iam.workloadIdentityUser \
    --member="principal://iam.googleapis.com/${POOL_ID}/subject/repo:${REPO}:environment:${2}" >/dev/null
}
bind_env "$AUDITOR" security-audit
bind_env "$PUBLISHER" security-audit-publish

# auditor: list/read prior runs and write new ones (no delete). No secrets.
for role in roles/storage.objectCreator roles/storage.objectViewer; do
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${AUDITOR}@${PROJECT}.iam.gserviceaccount.com" --role="$role" >/dev/null
done
# publisher: read reports and the globalhost-ops issues token. Nothing else.
g secrets add-iam-policy-binding globalhost-ops-issues-token \
  --member="serviceAccount:${PUBLISHER}@${PROJECT}.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${PUBLISHER}@${PROJECT}.iam.gserviceaccount.com" --role=roles/storage.objectViewer >/dev/null

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
