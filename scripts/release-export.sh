#!/usr/bin/env bash
# Export only committed HEAD, with no inherited branches, remotes or history.
# The source repository remains unchanged. No network writes occur.
set -euo pipefail
cd "$(dirname "$0")/.."
destination="${1:?usage: release:export -- /absolute/path/to/new-directory}"
[[ "$destination" == /* ]] || { echo "use an absolute destination outside this repository" >&2; exit 2; }
source_dir="$(pwd -P)"
destination="$(realpath -m "$destination")"
[[ "$destination" != "$source_dir" && "$destination" != "$source_dir/"* ]] || { echo "destination must be outside the source repository" >&2; exit 2; }
[[ ! -e "$destination" ]] || { echo "destination already exists; refusing to overwrite it" >&2; exit 1; }
git diff --quiet HEAD || { echo "commit tracked changes before exporting" >&2; exit 1; }
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "untracked files would be omitted; commit or ignore them before exporting" >&2
  exit 1
fi
: "${MORK_RELEASE_AUTHOR:?set the public author name for the export}"
: "${MORK_RELEASE_EMAIL:?set the public author email for the export}"
version="$(jq -er '.version' package.json)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "package.json needs a release version" >&2; exit 2; }
mkdir -p "$destination"
git archive HEAD | tar -x -C "$destination"
git -C "$destination" init -q -b main
git -C "$destination" config user.name "$MORK_RELEASE_AUTHOR"
git -C "$destination" config user.email "$MORK_RELEASE_EMAIL"
git -C "$destination" add .
git -C "$destination" -c commit.gpgsign=false commit -q -m "feat: publish Mork $version source"
git -C "$destination" -c tag.gpgsign=false tag "v$version"
gitleaks git --redact "$destination"
echo "exported committed HEAD to $destination; review before publishing"
