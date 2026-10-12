#!/usr/bin/env bash
# Exercise the real runner users and filesystem boundaries without AWS or network.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 --target runner-test -t mork-runner:test .
docker run --rm --network none --mount "type=bind,source=$(pwd -P),target=/opt/mork,readonly" mork-runner:test
# The fixture model runs on loopback; execute compiled development operations
# with production Node/Pi and a trusted local Git remote as the agent user.
docker run --rm --network none --user 10001:10001 \
  --mount "type=bind,source=$(pwd -P),target=/tests,readonly" -w /tests \
  -e MORK_LOCAL_E2E_PI=/usr/local/bin/pi \
  -e MORK_LOCAL_E2E_CLI=/opt/mork/packages/runner/src/local-cli.ts \
  -e MORK_LOCAL_E2E_RUNTIME=node \
  --entrypoint bun mork-runner:test test packages/runner/src/local.integration.test.ts
