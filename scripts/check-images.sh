#!/usr/bin/env bash
# Exercise final-image runtimes and enforce their size limits without AWS/network.
set -euo pipefail
cd "$(dirname "$0")/.."
for target in runner lambda; do
  options=()
  if [[ "$target" == lambda ]]; then options=(--read-only --tmpfs /tmp --user 10001:10001); fi
  docker run --rm --network none "${options[@]}" \
    --mount "type=bind,source=$(pwd -P)/scripts/images.runtime.ts,target=/images.runtime.ts,readonly" \
    --entrypoint node "mork-${target}:dev" /images.runtime.ts "$target"
done
docker run --rm --network none \
  --mount "type=bind,source=$(pwd -P)/scripts/workflows.runtime.ts,target=/workflows.runtime.ts,readonly" \
  --entrypoint node mork-runner:dev /workflows.runtime.ts
# Use the real proxy entrypoint, including per-task CA creation and both config templates.
docker run --rm --network none \
  -e MORK_LLM_HOST=llm.example.test -e MORK_EGRESS_ALLOW=registry.example.test,packages.example.test \
  -e MORK_REPO=example/repo -e GITHUB_PUSH_TOKEN=image-test-token \
  --entrypoint sh mork-egress:dev -c '
set -eu
: >/tmp/proxy.log
/usr/local/bin/mork-egress >/tmp/proxy.log 2>&1 & pid=$!
trap '\''kill "$pid" 2>/dev/null || true'\'' EXIT
attempt=0
until grep -q "tunnel proxy starting" /tmp/proxy.log; do
  if ! kill -0 "$pid" 2>/dev/null || [ "$attempt" -ge 50 ]; then cat /tmp/proxy.log; exit 1; fi
  attempt=$((attempt + 1)); sleep 0.1
done
test -s /mork-egress/ca.crt
grep -q "registry.example.test" /run/mork-egress/config.yaml
! grep -q "registry.npmjs.org" /run/mork-egress/config.yaml
! grep -q "pypi.org" /run/mork-egress/config.yaml
grep -q "example/repo" /run/mork-egress/config.yaml
test "$(wget -qO- http://127.0.0.1:9090/healthz)" = OK
test ! -e /sbin/apk
test -s /usr/share/licenses/mork/NOTICE
test -s /usr/share/licenses/mork/licenses/iron-proxy.LICENSE'
echo "egress entrypoint, CA, config and health endpoint passed"
# Reject host configuration that could alter the generated proxy YAML.
if docker run --rm --network none -e MORK_LLM_HOST=llm.example.test \
  -e MORK_EGRESS_ALLOW=https://invalid.example.test mork-egress:dev >/dev/null 2>&1; then
  echo "egress accepted an invalid domain" >&2
  exit 1
fi
# Compare the same local Docker size metric across rebuilds.
for target in runner lambda egress; do
  case "$target" in runner) limit=400000000 ;; lambda) limit=230000000 ;; egress) limit=80000000 ;; esac
  size="$(docker image inspect "mork-${target}:dev" --format '{{.Size}}')"
  echo "${target}: ${size} bytes (budget ${limit})"
  if (( size > limit )); then echo "${target} exceeds its image size budget" >&2; exit 1; fi
done
