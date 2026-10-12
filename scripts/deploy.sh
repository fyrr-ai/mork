#!/usr/bin/env bash
# Builds the runner, egress and lambda images, pushes them under the commit tag
# and the mutable `current` tag, and points the Lambda functions at the new
# image. Phase containers pick up `current` on their next RunTask.
#   mise run deploy
# Names follow the Terraform module's `name` (MORK_NAME, default "mork");
# override MORK_ECR_PREFIX or MORK_FUNCTIONS when your resources are named differently.
# --images-only uploads the initial images before the Lambda resources exist.
set -euo pipefail
cd "$(dirname "$0")/.."
name="${MORK_NAME:-mork}"
ecr_prefix="${MORK_ECR_PREFIX:-${name//_/-}}"
functions="${MORK_FUNCTIONS:-${name}_steps ${name}_intake ${name}_slack}"
images_only=false
case "${1:-}" in
  --images-only) images_only=true ;;
  "") ;;
  *) echo "usage: deploy [--images-only]" >&2; exit 2 ;;
esac
: "${AWS_REGION:?set AWS_REGION in mise.local.toml}"
for command in aws docker git; do
  command -v "$command" >/dev/null || { echo "missing prerequisite: $command" >&2; exit 1; }
done
account="$(aws sts get-caller-identity --query Account --output text)"
if [[ -n "${MORK_ACCOUNT:-}" && "$account" != "$MORK_ACCOUNT" ]]; then echo "logged in to $account, expected $MORK_ACCOUNT" >&2; exit 1; fi
if [[ -z "${ALLOW_DIRTY:-}" ]] && ! git diff --quiet HEAD; then echo "uncommitted changes: commit first (or ALLOW_DIRTY=1)" >&2; exit 1; fi
# Check every function before building or uploading anything. An API or IAM
# error is not treated as a missing function or a successful bootstrap.
if ! "$images_only"; then
  for fn in $functions; do
    aws lambda get-function --function-name "$fn" >/dev/null
  done
fi
registry="${account}.dkr.ecr.${AWS_REGION}.amazonaws.com"
tag="$(git rev-parse --short=12 HEAD)$(git diff --quiet HEAD || echo -dirty)"

aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
for target in runner egress lambda; do
  repo="${registry}/${ecr_prefix}-${target}"
  docker build --quiet --platform linux/amd64 --provenance=false --target "$target" -t "${repo}:${tag}" -t "${repo}:current" . >/dev/null
  docker push --quiet "${repo}:${tag}" >/dev/null
  docker push --quiet "${repo}:current" >/dev/null
  echo "pushed ${ecr_prefix}-${target}:${tag}"
done

if "$images_only"; then
  echo "uploaded ${tag}; apply the infrastructure to create the functions"
  exit 0
fi

digest="$(aws ecr describe-images --repository-name "${ecr_prefix}-lambda" --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)"
for fn in $functions; do
  aws lambda update-function-code --function-name "$fn" --image-uri "${registry}/${ecr_prefix}-lambda@${digest}" --query LastUpdateStatus --output text >/dev/null
  aws lambda wait function-updated-v2 --function-name "$fn"
  echo "updated ${fn}"
done
echo "deployed ${tag}"
