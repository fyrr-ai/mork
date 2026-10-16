#!/usr/bin/env bash
# Builds the runner, egress and lambda images, pushes them under the commit tag
# and the discovery-only `current` tag. Terraform pins every runtime by digest
# and steps Lambda invocations by version.
#   mise run deploy
# Names follow the Terraform module's `name` (MORK_NAME, default "mork");
# override MORK_ECR_PREFIX or MORK_FUNCTIONS when your resources are named differently.
# --images-only uploads the initial images before the Lambda resources exist.
set -euo pipefail
cd "$(dirname "$0")/.."
name="${MORK_NAME:-mork}"
ecr_prefix="${MORK_ECR_PREFIX:-${name//_/-}}"
infra_dir="${MORK_INFRA_DIR:-infra/aws/examples/basic}"
functions="${MORK_FUNCTIONS:-${name}_steps ${name}_intake ${name}_slack}"
images_only=false
soci_enabled=false
for argument in "$@"; do
  case "$argument" in
    --images-only) images_only=true ;;
    --soci) soci_enabled=true ;;
    *) echo "usage: deploy [--images-only] [--soci]" >&2; exit 2 ;;
  esac
done
: "${AWS_REGION:?set AWS_REGION in mise.local.toml}"
for command in aws docker git jq; do
  command -v "$command" >/dev/null || { echo "missing prerequisite: $command" >&2; exit 1; }
done
if "$soci_enabled"; then
  for command in soci crane jq; do
    command -v "$command" >/dev/null || { echo "missing SOCI prerequisite: $command (use mise run deploy:soci)" >&2; exit 1; }
  done
  docker buildx version >/dev/null
fi
[[ -d "$infra_dir" ]] || { echo "deployment root does not exist: $infra_dir" >&2; exit 1; }
dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" && -z "${ALLOW_DIRTY:-}" ]]; then
  echo "uncommitted or untracked files: commit first (or ALLOW_DIRTY=1)" >&2
  exit 1
fi
if ! "$images_only"; then
  for command in tofu bun; do command -v "$command" >/dev/null || { echo "missing prerequisite: $command" >&2; exit 1; }; done
fi
account="$(aws sts get-caller-identity --query Account --output text)"
if [[ -n "${MORK_ACCOUNT:-}" && "$account" != "$MORK_ACCOUNT" ]]; then echo "logged in to $account, expected $MORK_ACCOUNT" >&2; exit 1; fi
# Check every function before building or uploading anything. An API or IAM
# error is not treated as a missing function or a successful bootstrap.
if ! "$images_only"; then
  for fn in $functions; do
    aws lambda get-function --function-name "$fn" >/dev/null
  done
fi
registry="${account}.dkr.ecr.${AWS_REGION}.amazonaws.com"
tag="$(git rev-parse --short=12 HEAD)"
if [[ -n "$dirty" ]]; then tag="${tag}-dirty-$(date +%s)-${RANDOM}"; fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
for target in runner egress lambda; do
  repo="${registry}/${ecr_prefix}-${target}"
  platform=linux/arm64
  if [[ "$target" == lambda ]]; then platform=linux/amd64; fi
  if "$soci_enabled" && [[ "$target" != lambda ]]; then
    builder=()
    if [[ -n "${MORK_SOCI_BUILDER:-}" ]]; then builder=(--builder "$MORK_SOCI_BUILDER"); fi
    docker buildx build "${builder[@]}" --platform "$platform" --provenance=false --target "$target" \
      --output "type=oci,dest=${work}/${target}.tar,compression=gzip,force-compression=true" . >/dev/null
    scripts/soci-publish.sh "${work}/${target}.tar" "${repo}:${tag}" current
  else
    docker build --quiet --platform "$platform" --provenance=false --target "$target" --load -t "${repo}:${tag}" -t "${repo}:current" . >/dev/null
    docker push --quiet "${repo}:${tag}" >/dev/null
    docker push --quiet "${repo}:current" >/dev/null
  fi
  echo "pushed ${ecr_prefix}-${target}:${tag}"
done

# Resolve all three uploaded images before changing the deployment inputs.
# For SOCI this records the converted manifest digest, not the original image.
for target in runner egress lambda; do
  digest="$(aws ecr describe-images --repository-name "${ecr_prefix}-${target}" --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid uploaded digest for $target" >&2; exit 1; }
  printf '%s' "$digest" >"${work}/${target}.digest"
done
jq -n --arg runner "$(cat "$work/runner.digest")" --arg egress "$(cat "$work/egress.digest")" --arg lambda "$(cat "$work/lambda.digest")"   '{image_digests: {runner: $runner, egress: $egress, lambda: $lambda}}' >"${work}/release.json"
cp "${work}/release.json" "$infra_dir/.mork-images.auto.tfvars.json"
echo "uploaded ${tag}; digests recorded in ${infra_dir}/.mork-images.auto.tfvars.json"
if "$images_only"; then
  echo "run mise run infra:apply to activate these images"
else
  # A single reviewed apply updates task revisions, publishes the steps version,
  # then changes state machines. Existing executions retain their pinned code.
  MORK_INFRA_DIR="$infra_dir" scripts/apply.sh "${work}/release.json"
fi
