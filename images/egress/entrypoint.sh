#!/bin/sh
# Egress sidecar of a phase task. Creates a CA for this task only (the key
# never leaves this container; the certificate goes to the volume the station
# container trusts), writes the config and starts iron-proxy. The station
# reaches it on 127.0.0.1 (shared task network) through HTTPS_PROXY.
set -eu
KEYDIR=/run/mork-egress
SHARED=${MORK_EGRESS_SHARED:-/mork-egress}
mkdir -p "$KEYDIR" "$SHARED"
iron-proxy generate-ca -outdir "$KEYDIR" -name "mork egress $(hostname)" -alg ed25519 -expiry-hours 48 >/dev/null
cp "$KEYDIR/ca.crt" "$SHARED/ca.tmp" && chmod 0644 "$SHARED/ca.tmp" && mv "$SHARED/ca.tmp" "$SHARED/ca.crt"

config=/run/mork-egress/config.yaml
# MORK_EGRESS_ALLOW: extra hosts for the allowlist, comma separated (package registries, artifact stores…).
extra=""
old_ifs=$IFS; IFS=,
for host in ${MORK_EGRESS_ALLOW:-}; do
  # Host-only configuration must not inject YAML or sed replacements.
  if ! printf '%s\n' "$host" | grep -Eq '^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'; then
    echo "Invalid allowed domain: $host" >&2
    exit 1
  fi
  [ -n "$host" ] && extra="${extra}        - \"${host}\"\n"
done
IFS=$old_ifs
sed -e "s|@LLM_HOST@|${MORK_LLM_HOST:?MORK_LLM_HOST is required}|g" \
    -e "s|@ALLOW_WARN@|${MORK_EGRESS_WARN:-true}|g" \
    -e "s|        # @EXTRA_DOMAINS@.*|${extra%\\n}|" /etc/mork-egress/base.yaml > "$config"
# Build is the only phase that pushes: only its sidecar holds the push token.
if [ -n "${GITHUB_TOKEN:-}${GITHUB_TOKEN_FILE:-}" ]; then
  if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
    echo "Configure only one GitHub credential source" >&2; exit 1
  fi
  case "${MORK_REPO:-}" in
    */*) ;;
    *) echo "MORK_REPO (owner/repo) is required when the push token is set" >&2; exit 1 ;;
  esac
  if ! printf '%s\n' "$MORK_REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    echo "Invalid repository name" >&2; exit 1
  fi
  template=/etc/mork-egress/github-push.yaml
  if [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
    [ "$GITHUB_TOKEN_FILE" = /mork-egress/github-token ] || { echo "Invalid GitHub token file" >&2; exit 1; }
    template=/etc/mork-egress/github-app.yaml
  fi
  sed -e "s|@REPO@|${MORK_REPO}|g" "$template" >> "$config"
fi
exec iron-proxy -config "$config"
