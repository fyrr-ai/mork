#!/usr/bin/env bash
# Applies the repository rulesets Mork relies on, because the
# implementer pushes with its own token: the default branch only changes
# through pull requests (no force-push, no deletion), and new branches must
# be mork/*. Rulesets need an organization repository (or GitHub Pro).
# Re-running replaces rulesets with the same name, so it converges.
#   mise run rulesets:apply -- <owner/repo>
set -euo pipefail
repo="${1:?usage: rulesets:apply -- <owner/repo>}"
dir="$(dirname "$0")/rulesets"
for file in "$dir"/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api "repos/${repo}/rulesets" --jq ".[] | select(.name == \"${name}\") | .id")"
  if [[ -n "$id" ]]; then
    gh api -X PUT "repos/${repo}/rulesets/${id}" --input "$file" --jq .name >/dev/null
    echo "updated ruleset: ${name}"
  else
    gh api -X POST "repos/${repo}/rulesets" --input "$file" --jq .name >/dev/null
    echo "created ruleset: ${name}"
  fi
done
