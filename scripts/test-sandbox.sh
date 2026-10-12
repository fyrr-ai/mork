#!/usr/bin/env bash
# Exercise the real runner users and filesystem boundaries without AWS or network.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 --target runner-test -t mork-runner:test .
docker run --rm --network none --mount "type=bind,source=$(pwd -P),target=/opt/mork,readonly" mork-runner:test
