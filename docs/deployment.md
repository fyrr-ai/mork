# Deployment

Mork runs in one AWS account. You need: a VPC with private subnets and outbound HTTPS (NAT), Docker, the AWS CLI, [mise](https://mise.jdx.dev), an OpenAI-compatible LLM endpoint, and GitHub tokens (see [configuration](configuration.md#secrets)).

## 1. Local settings

```sh
mise install
cat > mise.local.toml <<'EOF'
[env]
AWS_PROFILE = "your-profile"
AWS_REGION = "eu-west-1"
MORK_ACCOUNT = "123456789012"
EOF
mise run check   # unit tests, typecheck, lint
```

## 2. Secrets

```sh
MORK_LLM_API_KEY=... \
MORK_GITHUB_TOKEN=... MORK_GITHUB_READ_TOKEN=... MORK_GITHUB_PUSH_TOKEN=... \
mise run secrets:put
```

Add `JEV_API` or `OPENAI_API_KEY` for a decision model, and `MORK_SLACK_SIGNING_SECRET`, `MORK_SLACK_BOT_TOKEN`, `MORK_JIRA_API_TOKEN` for Slack. The script never prints values.

## 3. Infrastructure

Use the module in [`infra/aws`](../infra/aws); [`infra/aws/examples/basic`](../infra/aws/examples/basic/main.tf) is a starting point.

```sh
cd infra/aws/examples/basic   # or your own root module
terraform init && terraform apply
```

The first apply creates the ECR repositories, the state machine, the ECS cluster and task definitions, the Lambdas, the bucket and the timeline table. Lambdas need an image to exist; if the apply fails on them, run step 4 and apply again.

## 4. Images

```sh
mise run deploy
```

Builds the `runner`, `egress` and `lambda` images, pushes them under the commit tag and `current`, and points the Lambdas at the new image. Phase containers pick up `current` on their next run. The script refuses a dirty tree and any account other than `MORK_ACCOUNT`.

## 5. A repository

1. Add `.mork/config.toml` to its default branch ([reference](configuration.md#repository-configuration)) and, optionally, `AGENTS.md`.
2. Add it to `repo_allowlist` and apply.
3. Add a webhook: the module's `webhook_url` output, content type JSON, secret `<prefix>/webhook-secret`, events Issues, Pull requests, Pull request reviews, Pull request review comments, Issue comments and Check suites.
4. `mise run rulesets:apply -- owner/repo`: the default branch changes only through pull requests with one fresh approval; new branches must be `factory/*` (needs an organization repository or GitHub Pro).
5. Label an issue `factory` (needs at least triage access).

## 6. Slack (optional)

1. Create a Slack app from [`packages/sources/slack-app-manifest.yaml`](../packages/sources/slack-app-manifest.yaml) and set the Event Subscriptions request URL to the module's `slack_events_url` output.
2. Store the signing secret and bot token (step 2), map channels in `slack_channels`, set `jira_base_url` and `jira_email`, and apply.
3. Invite the bot to the channel and mention it: `@mork add …` or `@mork implement PROJ-123`.

## Operating

| Task | Command |
| --- | --- |
| Follow the newest execution | `mise run e2e:watch` |
| Export decisions for calibration | `mise run timeline:export -- recommendation > data.jsonl` |
| Revoke the GitHub tokens | `mise run secrets:put -- --delete-github`, then apply again |

Logs: `/ecs/<name>/stations` (prefixes `<phase>` and `<phase>-egress`), `/aws/lambda/<name>_*`, the state machine's log group, and the live log if `otlp_endpoint` is set.
