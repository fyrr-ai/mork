#!/usr/bin/env bash
# Actual final-image proxy requests, including host-scoped credential injection.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm --network none \
  --add-host service.example.test:127.0.0.1 --add-host second.example.test:127.0.0.1 \
  --add-host other.example.test:127.0.0.1 --add-host denied.example.test:127.0.0.1 \
  -e MORK_LLM_HOST=llm.example.test -e MORK_EGRESS_WARN=false \
  -e MORK_EGRESS_ALLOW=service.example.test,other.example.test \
  -e MORK_SERVICE_BINDINGS=$'service.example.test=MORK_SERVICE_AUTH_0\nsecond.example.test=MORK_SERVICE_AUTH_1' \
  -e MORK_SERVICE_AUTH_1='Basic c2Vjb25kOmZpeHR1cmU=' \
  -e MORK_SERVICE_AUTH_0='Basic dGVzdDpmaXh0dXJl' \
  --entrypoint sh mork-egress:dev -c '
set -eu
# Loopback exception applies only to this disposable server fixture.
sed -i "/^proxy:$/a\\  upstream_deny_cidrs: []" /etc/mork-egress/base.yaml
mkdir -p /tmp/www/cgi-bin
printf "/cgi-bin:test:fixture\\n" > /tmp/www/httpd.conf
printf "#!/bin/sh\\nprintf '\''Content-Type: text/plain\\n\\nauthenticated\\n'\''\\n" > /tmp/www/cgi-bin/query
chmod 755 /tmp/www/cgi-bin/query
httpd -f -p 8081 -h /tmp/www &
mkdir -p /tmp/second
cp -r /tmp/www/cgi-bin /tmp/second/
printf "/cgi-bin:second:fixture\\n" > /tmp/second/httpd.conf
httpd -f -p 8082 -h /tmp/second &
/usr/local/bin/mork-egress >/tmp/proxy.log 2>&1 & pid=$!
trap '\''kill "$pid" 2>/dev/null || true'\'' EXIT
attempt=0
until wget -qO- http://127.0.0.1:9090/healthz >/dev/null 2>&1; do
  if ! kill -0 "$pid" 2>/dev/null || [ "$attempt" -ge 50 ]; then cat /tmp/proxy.log; exit 1; fi
  attempt=$((attempt + 1)); sleep 0.1
done
# A request with a placeholder is authenticated only at the configured host.
test "$(http_proxy=http://127.0.0.1:18080 wget -qO- --header="Authorization: placeholder" http://service.example.test:8081/cgi-bin/query)" = authenticated
test "$(http_proxy=http://127.0.0.1:18080 wget -qO- http://second.example.test:8082/cgi-bin/query)" = authenticated
if http_proxy=http://127.0.0.1:18080 wget -qO- http://service.example.test:8082/cgi-bin/query >/dev/null 2>&1; then
  echo "Proxy used another service credential" >&2; exit 1
fi
if http_proxy=http://127.0.0.1:18080 wget -qO- http://denied.example.test:8081/ >/dev/null 2>&1; then
  echo "Proxy allowed a host outside the list" >&2; exit 1
fi
if http_proxy=http://127.0.0.1:18080 wget -qO- http://other.example.test:8081/cgi-bin/query >/dev/null 2>&1; then
  echo "Proxy authenticated another service host" >&2; exit 1
fi
# Authenticated upstream rejects a direct request from the agent.
if wget -qO- http://service.example.test:8081/cgi-bin/query >/dev/null 2>&1; then
  echo "Service accepted an unauthenticated direct request" >&2; exit 1
fi
! grep -q "dGVzdDpmaXh0dXJl" /run/mork-egress/config.yaml
! grep -q "dGVzdDpmaXh0dXJl" /tmp/proxy.log
! grep -q "c2Vjb25kOmZpeHR1cmU=" /run/mork-egress/config.yaml
! grep -q "c2Vjb25kOmZpeHR1cmU=" /tmp/proxy.log'
for host in 'https://service.example.test' '*.example.test' 'service.example.test:8123' $'service.example.test\ninjected: true' 'github.com' 'llm.example.test'; do
  if docker run --rm --network none -e MORK_LLM_HOST=llm.example.test \
    -e "MORK_SERVICE_BINDINGS=$host=MORK_SERVICE_AUTH_0" -e MORK_SERVICE_AUTH_0=fixture \
    mork-egress:dev >/dev/null 2>&1; then
    echo "egress accepted an invalid service host" >&2; exit 1
  fi
done
# Duplicate hosts, missing credentials and arbitrary env names fail before listening.
for bindings in 'service.example.test=MORK_SERVICE_AUTH_9' 'service.example.test=LLM_API_KEY' \
  'service.example.test' 'service.example.test=MORK_SERVICE_AUTH_0=extra' \
  $'service.example.test=MORK_SERVICE_AUTH_0\nservice.example.test=MORK_SERVICE_AUTH_1'; do
  if docker run --rm --network none -e MORK_LLM_HOST=llm.example.test \
    -e "MORK_SERVICE_BINDINGS=$bindings" -e MORK_SERVICE_AUTH_0=fixture -e MORK_SERVICE_AUTH_1=second \
    mork-egress:dev >/dev/null 2>&1; then
    echo "egress accepted invalid service bindings" >&2; exit 1
  fi
done
# Old deployment fields must not silently start without authentication.
if docker run --rm --network none -e MORK_LLM_HOST=llm.example.test \
  -e MORK_SERVICE_HOST=service.example.test -e MORK_SERVICE_AUTHORIZATION=fixture \
  mork-egress:dev >/dev/null 2>&1; then
  echo "egress accepted replaced single-service fields" >&2; exit 1
fi
echo 'service authentication: two exact hosts, isolated credentials, allowlist enforcement and no secret in config/logs'
