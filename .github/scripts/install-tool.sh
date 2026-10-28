#!/usr/bin/env bash
# Install a release binary only if its tarball matches a pinned SHA-256.
# Usage: install-tool.sh <url> <sha256> <path-in-tarball> [strip-components]
set -euo pipefail
url="$1" sha="$2" bin="$3" strip="${4:-0}"
dest="${RUNNER_TEMP:?}/tools"
mkdir -p "$dest"
tarball="$(mktemp "${RUNNER_TEMP}/tool.XXXXXX")"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$tarball" "$url"
echo "${sha}  ${tarball}" | sha256sum --check --strict -
tar --extract --gzip --file "$tarball" --directory "$dest" --strip-components "$strip" "$bin"
rm -f "$tarball"
echo "$dest" >> "$GITHUB_PATH"
