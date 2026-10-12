#!/usr/bin/env bash
# Validate and apply the same saved plan, including every runner output schema.
set -euo pipefail
cd "$(dirname "$0")/.."
infra_dir="${MORK_INFRA_DIR:-infra/aws/examples/basic}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
variables=()
if [[ $# -gt 0 ]]; then variables=(-var-file="$(realpath "$1")"); fi
tofu -chdir="$infra_dir" plan "${variables[@]}" -out="$work/release.tfplan"
tofu -chdir="$infra_dir" show -json "$work/release.tfplan" >"$work/release.json"
bun scripts/validate-plan.ts "$work/release.json"
# Saved plans apply without a further Terraform prompt. The caller explicitly
# invokes infra:apply/deploy; validation must finish before any resources change.
tofu -chdir="$infra_dir" apply "$work/release.tfplan"
