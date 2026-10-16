#!/usr/bin/env bash
# Exercise final-image runtimes and enforce their size limits without AWS/network.
set -euo pipefail
cd "$(dirname "$0")/.."
targets=" ${MORK_IMAGE_TARGETS:-runner egress lambda} "
for target in $targets; do
  case "$target" in runner|egress|lambda) ;; *) echo "Invalid image target: $target" >&2; exit 2 ;; esac
done
for target in runner lambda; do
  [[ "$targets" == *" $target "* ]] || continue
  options=()
  if [[ "$target" == lambda ]]; then options=(--read-only --tmpfs /tmp --user 10001:10001); fi
  docker run --rm --network none "${options[@]}" \
    --mount "type=bind,source=$(pwd -P)/scripts/images.runtime.ts,target=/images.runtime.ts,readonly" \
    --entrypoint node "mork-${target}:dev" /images.runtime.ts "$target"
done
if [[ "$targets" == *" runner "* ]]; then
docker run --rm --network none \
  --mount "type=bind,source=$(pwd -P)/scripts/workflows.runtime.ts,target=/workflows.runtime.ts,readonly" \
  --entrypoint node mork-runner:dev /workflows.runtime.ts
fi
if [[ "$targets" == *" egress "* ]]; then
[[ "$(docker image inspect mork-egress:dev --format '{{.Architecture}}')" == arm64 ]] || { echo "egress must be ARM64" >&2; exit 1; }
# Use the real proxy entrypoint, including per-task CA creation and both config templates.
docker run --rm --network none \
  -e MORK_LLM_HOST=llm.example.test -e MORK_EGRESS_ALLOW=registry.example.test,packages.example.test \
  -e MORK_REPO=example/repo -e GITHUB_TOKEN=image-test-token \
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
grep -q "var: GITHUB_TOKEN" /run/mork-egress/config.yaml
test "$(wget -qO- http://127.0.0.1:9090/healthz)" = OK
test ! -e /sbin/apk
test -s /usr/share/licenses/mork/NOTICE
test -s /usr/share/licenses/mork/licenses/iron-proxy.LICENSE'
echo "egress entrypoint, CA, config and health endpoint passed"
# The final proxy must pick up a renewed token without restarting. Loopback is
# enabled only in this isolated test image; production retains the deny list.
docker run --rm --network none --add-host github.com:127.0.0.1 \
  -e MORK_LLM_HOST=llm.example.test -e MORK_REPO=cgi-bin/repo \
  -e GITHUB_TOKEN_FILE=/mork-egress/github-token \
  --entrypoint sh mork-egress:dev -c '
set -eu
sed -i "/^proxy:$/a\\  upstream_deny_cidrs: []" /etc/mork-egress/base.yaml
mkdir -p /tmp/www/cgi-bin /mork-egress
printf first-token > /mork-egress/github-token
chmod 600 /mork-egress/github-token
printf "/cgi-bin:x-access-token:first-token\\n" > /tmp/www/httpd.conf
printf "#!/bin/sh\\nprintf '\''Content-Type: text/plain\\n\\n'\''\\nprintf authenticated\\n" > /tmp/www/cgi-bin/repo.git
chmod 755 /tmp/www/cgi-bin/repo.git
cp /tmp/www/cgi-bin/repo.git /tmp/www/cgi-bin/other.git
httpd -f -p 8081 -h /tmp/www & httpd_pid=$!
/usr/local/bin/mork-egress >/tmp/proxy.log 2>&1 & pid=$!
trap '\''kill "$pid" 2>/dev/null || true'\'' EXIT
attempt=0
until wget -qO- http://127.0.0.1:9090/healthz >/dev/null 2>&1; do
  if ! kill -0 "$pid" 2>/dev/null || [ "$attempt" -ge 50 ]; then cat /tmp/proxy.log; exit 1; fi
  attempt=$((attempt + 1)); sleep 0.1
done
fetch() { http_proxy=http://127.0.0.1:18080 wget -qO- "http://github.com:8081/cgi-bin/$1.git/test"; }
test "$(fetch repo)" = authenticated
if fetch other >/dev/null 2>&1; then echo "Proxy authenticated another repository" >&2; exit 1; fi
printf renewed-token > /mork-egress/github-token.tmp
chmod 600 /mork-egress/github-token.tmp
mv /mork-egress/github-token.tmp /mork-egress/github-token
printf "/cgi-bin:x-access-token:renewed-token\\n" > /tmp/www/httpd.conf
kill "$httpd_pid"
wait "$httpd_pid" || true
httpd -f -p 8081 -h /tmp/www & httpd_pid=$!
sleep 31
test "$(fetch repo)" = authenticated
kill -0 "$pid"
test "$(stat -c %a /mork-egress/github-token)" = 600'
echo "running egress proxy accepted rotated credentials and rejected another repository"
# Reject host configuration that could alter the generated proxy YAML.
if docker run --rm --network none -e MORK_LLM_HOST=llm.example.test \
  -e MORK_EGRESS_ALLOW=https://invalid.example.test mork-egress:dev >/dev/null 2>&1; then
  echo "egress accepted an invalid domain" >&2
  exit 1
fi
fi
# Compare the same local Docker size metric across rebuilds.
# ARM64 glibc conversion modules occupy ~19.7 MB; the measured runner is ~464 MB.
# Keep the original x86 budget and allow 470 MB for the ARM64 runtime without dropping libraries.
for target in runner lambda egress; do
  [[ "$targets" == *" $target "* ]] || continue
  case "$target" in runner) limit=460000000; if [[ "$(docker image inspect "mork-${target}:dev" --format '{{.Architecture}}')" == arm64 ]]; then limit=470000000; fi ;; lambda) limit=230000000 ;; egress) limit=80000000 ;; esac
  size="$(docker image inspect "mork-${target}:dev" --format '{{.Size}}')"
  echo "${target}: ${size} bytes (budget ${limit})"
  if (( size > limit )); then echo "${target} exceeds its image size budget" >&2; exit 1; fi
done
