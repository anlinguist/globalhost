#!/usr/bin/env bash
# One-time setup for the factory's Pulumi backend (ADR-0008). Owner-run. Safe to re-run.
#
# Creates exactly the two things Pulumi needs before it can run, so the factory program
# (infra/factory) does not manage them:
#   - gs://globalhost-pulumi-state   state backend (versioned; old versions expire)
#   - KMS keyring `pulumi`, key `state`   secrets provider for every stack
# If Pulumi managed these, a `pulumi destroy` (or a bad diff) could delete the bucket holding its own
# state or schedule its own decryption key for destruction. They stay outside the program on purpose.
set -euo pipefail

PROJECT="${PROJECT:-globalhost-factory}"
REGION="${REGION:-us-central1}"
BUCKET="globalhost-pulumi-state"
KEYRING="pulumi"
KEY="state"

g() { gcloud --project="$PROJECT" --quiet "$@"; }
exists() { "$@" >/dev/null 2>&1; }

g services enable storage.googleapis.com cloudkms.googleapis.com

# State bucket: private, versioned. A noncurrent version is deleted 90 days after it was replaced
# (and only once 10 newer versions exist), so state history is recoverable without growing forever.
exists gcloud storage buckets describe "gs://${BUCKET}" ||
  gcloud storage buckets create "gs://${BUCKET}" --project="$PROJECT" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://${BUCKET}" --versioning
LIFECYCLE="$(mktemp)"
trap 'rm -f "$LIFECYCLE"' EXIT
cat > "$LIFECYCLE" <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":90,"numNewerVersions":10}}]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE"

# KMS key for Pulumi secrets. Keyrings and keys can't be deleted, only their versions destroyed.
exists g kms keyrings describe "$KEYRING" --location=global ||
  g kms keyrings create "$KEYRING" --location=global
exists g kms keys describe "$KEY" --keyring="$KEYRING" --location=global ||
  g kms keys create "$KEY" --keyring="$KEYRING" --location=global --purpose=encryption \
    --rotation-period=365d --next-rotation-time="$(date -u -v+365d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+365 days' +%Y-%m-%dT%H:%M:%SZ)"

cat <<OUT

Done. Next (from infra/factory, see its README):
  pulumi login gs://${BUCKET}
  pulumi stack init prod --secrets-provider="gcpkms://projects/${PROJECT}/locations/global/keyRings/${KEYRING}/cryptoKeys/${KEY}"
OUT
