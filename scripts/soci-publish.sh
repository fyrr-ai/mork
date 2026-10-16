#!/usr/bin/env bash
# Convert an OCI layout/archive to SOCI v2 and publish its complete index.
# No containerd service, privileged helper or Docker socket is required.
set -euo pipefail
if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo "usage: soci-publish SOURCE_OCI IMAGE_REF [ALIAS_TAG]" >&2
  exit 2
fi
for command in soci crane jq; do
  command -v "$command" >/dev/null || { echo "missing prerequisite: $command" >&2; exit 1; }
done
source_layout="$1"
image_ref="$2"
alias_tag="${3:-}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
soci convert --standalone --format oci-dir --platform linux/arm64 "$source_layout" "$work/indexed" >/dev/null
# The layout wraps the deployable image index. Fail before publishing if the
# converter did not create the v2 artifact required by fresh Fargate accounts.
index_digest="$(jq -er '.manifests[0].digest' "$work/indexed/index.json")"
[[ "$index_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "invalid SOCI image index digest" >&2; exit 1; }
index_manifest="$work/indexed/blobs/sha256/${index_digest#sha256:}"
jq -e '.manifests | any(.artifactType == "application/vnd.amazon.soci.index.v2+json")' "$index_manifest" >/dev/null
crane push "$work/indexed" "$image_ref" >/dev/null
crane manifest "$image_ref" | jq -e '.manifests | any(.artifactType == "application/vnd.amazon.soci.index.v2+json")' >/dev/null
# Update the moving tag only after publishing and checking the complete graph.
if [[ -n "$alias_tag" ]]; then crane tag "$image_ref" "$alias_tag"; fi
echo "published SOCI v2 ${image_ref}"
