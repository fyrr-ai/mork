#!/usr/bin/env bash
# Creates or updates the Secrets Manager secrets the Mork stack reads.
# Values never pass through Terraform, git or the terminal.
# Each value comes from an environment variable; unset ones are left alone
# (or get a placeholder the first time, so the stack can be applied).
#   MORK_LLM_API_KEY          key for the OpenAI-compatible LLM (egress sidecar, steps Lambda)
#   JEV_API, OPENAI_API_KEY   decision-model keys (optional)
#   MORK_GITHUB_TOKEN         Lambdas: issues, PRs, labels, comments, checks
#   MORK_GITHUB_READ_TOKEN    containers: read-only clone (must differ from the token above)
#   MORK_GITHUB_PUSH_TOKEN    egress sidecar in Build: Contents RW on the allowlisted repos, no workflows
#   MORK_SLACK_SIGNING_SECRET, MORK_SLACK_BOT_TOKEN, MORK_JIRA_API_TOKEN   Slack source (optional)
# The webhook secret is generated once.
#   mise run secrets:put
#   mise run secrets:put -- --delete-github   remove the GitHub token secrets
# Secret names are <MORK_SECRET_PREFIX>/<name>, prefix default "mork".
set -euo pipefail
prefix="${MORK_SECRET_PREFIX:-${MORK_NAME:-mork}}"

put() { # name; value on stdin
  local name="$1"
  if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$name" --secret-string file:///dev/stdin >/dev/null
    echo "updated $name"
  else
    aws secretsmanager create-secret --name "$name" --secret-string file:///dev/stdin \
      --tags Key=RotationPolicy,Value=manual Key=Service,Value="$prefix" >/dev/null
    echo "created $name"
  fi
}

if [[ "${1:-}" == "--delete-github" ]]; then
  # put-secret-value would keep the token as the AWSPREVIOUS version, so the
  # secrets are deleted for good and recreated with a placeholder. Their ARNs
  # change: re-apply the Terraform stack afterwards.
  for name in "$prefix/github-token" "$prefix/github-read-token" "$prefix/github-push-token"; do
    aws secretsmanager delete-secret --secret-id "$name" --force-delete-without-recovery >/dev/null 2>&1 || true
    # Deletion finishes asynchronously; recreate only once the name is free.
    for _ in $(seq 1 60); do aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1 || break; sleep 3; done
    created=""
    for _ in $(seq 1 60); do
      if aws secretsmanager create-secret --name "$name" --secret-string revoked \
        --tags Key=RotationPolicy,Value=manual Key=Service,Value="$prefix" >/dev/null 2>&1; then created=1; break; fi
      sleep 3
    done
    [[ -n "$created" ]] || { echo "could not recreate $name" >&2; exit 1; }
    echo "recreated $name"
  done
  echo "Stored GitHub secrets removed. The tokens themselves remain valid: revoke each token in GitHub, then re-apply the stack."
  exit 0
fi

put_optional() { # name, variable; placeholder the first time when the variable is unset
  local name="$1" var="$2"
  if [[ -n "${!var:-}" ]]; then
    printf '%s' "${!var}" | put "$name"
  elif ! aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    printf 'unset' | put "$name"
    echo "$name holds a placeholder (set $var)"
  fi
}

put_optional "$prefix/llm-api-key" MORK_LLM_API_KEY
put_optional "$prefix/jev-api-key" JEV_API
if [[ -n "${OPENAI_API_KEY:-}" ]]; then printf '%s' "$OPENAI_API_KEY" | put "$prefix/openai-api-key"; fi
if ! aws secretsmanager describe-secret --secret-id "$prefix/webhook-secret" >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' | put "$prefix/webhook-secret"
fi

# Three GitHub credentials with three scopes: the Lambdas (issues, PRs, labels),
# the containers' read-only clone, and the egress sidecar's push in Build.
# Containers can be compromised by the code they run, so the read token must
# never be the Lambdas' write token.
if [[ -n "${MORK_GITHUB_TOKEN:-}" && -n "${MORK_GITHUB_READ_TOKEN:-}" && "$MORK_GITHUB_TOKEN" == "$MORK_GITHUB_READ_TOKEN" ]]; then
  echo "MORK_GITHUB_READ_TOKEN must be a separate read-only token, not MORK_GITHUB_TOKEN" >&2
  exit 1
fi
put_optional "$prefix/github-token" MORK_GITHUB_TOKEN
put_optional "$prefix/github-read-token" MORK_GITHUB_READ_TOKEN
put_optional "$prefix/github-push-token" MORK_GITHUB_PUSH_TOKEN
put_optional "$prefix/slack-signing-secret" MORK_SLACK_SIGNING_SECRET
put_optional "$prefix/slack-bot-token" MORK_SLACK_BOT_TOKEN
put_optional "$prefix/jira-api-token" MORK_JIRA_API_TOKEN
