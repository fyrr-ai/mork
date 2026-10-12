#!/usr/bin/env bash
# Applies the repository rulesets Mork relies on, because the
# implementer pushes with its own token: the default branch only changes
# through pull requests (no force-push, no deletion). A Write-role agent can
# only create, update and delete mork/* branches and cannot change tags.
# Maintainers and admins bypass the non-agent branch and tag restrictions.
# Public repositories support rulesets on Free; private ones need a paid plan.
# Re-running replaces rulesets with the same name, so it converges.
#   mise run rulesets:apply -- <owner/repo>
set -euo pipefail
repo="${1:?usage: rulesets:apply -- <owner/repo>}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "expected owner/repo" >&2; exit 2; }
dir="$(dirname "$0")/rulesets"
for file in "$dir"/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api --paginate "repos/${repo}/rulesets?includes_parents=false&per_page=100" | jq -r --arg name "$name" '.[] | select(.name == $name) | .id')"
  [[ "$id" != *$'\n'* ]] || { echo "duplicate rulesets named $name; remove the duplicate first" >&2; exit 1; }
  if [[ -n "$id" ]]; then
    gh api -X PUT "repos/${repo}/rulesets/${id}" --input "$file" --jq .name >/dev/null
    echo "updated ruleset: ${name}"
  else
    gh api -X POST "repos/${repo}/rulesets" --input "$file" --jq .name >/dev/null
    echo "created ruleset: ${name}"
  fi
done
