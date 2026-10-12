#!/bin/sh
# Retain standard npm metadata and upstream notices alongside bundled code.
set -eu
mkdir -p "$1"
find node_modules -type f \( -name package.json -o -iname 'license*' -o -iname 'licence*' \
  -o -iname 'notice*' -o -iname 'copyright*' -o -iname 'copying*' -o -iname '*third*party*license*' \) \
  -exec cp --parents '{}' "$1" \;
