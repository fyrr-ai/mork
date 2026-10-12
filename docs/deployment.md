# Deployment

Mork runs in one AWS account. You need a VPC with private subnets and outbound HTTPS through NAT, [mise](https://mise.jdx.dev), Git, Docker with Buildx, AWS CLI v2, GitHub CLI (`gh`), OpenSSL, and an OpenAI-compatible LLM endpoint. Mise installs the project's pinned Bun, Node, OpenTofu, jq and verification tools. Use separate GitHub machine-account tokens as described in [configuration](configuration.md#secrets).

## 1. Local settings

```sh
mise trust
mise install
mise run install
cat > mise.local.toml <<'SETTINGS'
[env]
AWS_PROFILE = "your-profile"
AWS_REGION = "your-region"
MORK_ACCOUNT = "123456789012"
MORK_NAME = "mork"
MORK_INFRA_DIR = "infra/aws/examples/basic"
SETTINGS
mise run check
```

The frozen dependency install precedes all tests. `check` runs unit and local runtime tests, type checking, lint, shell and workflow checks, OpenTofu validation and mocked AWS plan tests. It does not contact an AWS account or deploy resources.

## 2. Secrets

```sh
MORK_LLM_API_KEY=... \
MORK_GITHUB_TOKEN=... MORK_GITHUB_READ_TOKEN=... MORK_GITHUB_PUSH_TOKEN=... \
mise run secrets:put
```

Add `JEV_API` or `OPENAI_API_KEY` for a decision model, and `MORK_SLACK_SIGNING_SECRET`, `MORK_SLACK_BOT_TOKEN`, `MORK_JIRA_API_TOKEN` for Slack. The script never prints values. Missing values become `unset` on the first run. This is a disabled placeholder, not a usable signing secret. Configure required credentials before starting tasks.

## 3. First deployment

Copy or edit [`infra/aws/examples/basic`](../infra/aws/examples/basic/main.tf) with your actual subnets, repository and LLM configuration. Its provider reads `AWS_REGION` from the environment. If you use another root module, set `MORK_INFRA_DIR` to it and expose the Mork module as `module.mork` for the bootstrap task.

```sh
mise exec -- tofu -chdir=infra/aws/examples/basic init
mise run infra:bootstrap
mise run images:push
mise run infra:apply
```

The targeted bootstrap creates only the ECR repositories. `images:push` builds and uploads the three images without trying to update functions. The full apply can then create Lambdas from an existing image. Targeted apply is a first-install operation; ordinary changes use full `infra:apply`.

The module's dependency lockfile is committed. A separate deployment root needs its own committed lockfile and protected state backend. The example intentionally does not choose a production state backend for you.

## 4. Later deployments

```sh
mise run deploy
```

The script first confirms all configured functions exist, then builds and uploads the `runner`, `egress` and `lambda` images. It pins Lambdas to the uploaded digest. Phase containers resolve `image_tag`, which defaults to `current`, on their next run. It refuses tracked changes unless `ALLOW_DIRTY=1` and rejects a different account when `MORK_ACCOUNT` is set. Names with underscores use hyphens for ECR, matching the module. Use `MORK_ECR_PREFIX` and `MORK_FUNCTIONS` only for existing deployments with different names.

Base images are pinned by digest in `Dockerfile`; dependency installs use `bun.lock`. Review base-image updates and rebuild periodically for security patches. Configure infrastructure changes with `mise run infra:apply`.

## 5. A repository

1. Add `.mork/config.toml` to its default branch ([reference](configuration.md#repository-configuration)) and optionally `AGENTS.md`.
2. Add it to `repo_allowlist` and apply.
3. Add a webhook using `webhook_url`, content type JSON and secret `<prefix>/webhook-secret`. Subscribe to Issues, Pull requests, Pull request reviews, Pull request review comments, Issue comments and Check suites.
4. Run `mise run rulesets:apply -- owner/repo` with an administrative credential. These rules keep the default branch PR-only with a fresh approval. Write-role accounts can create, update and delete only `mork/*` branches and cannot change tags. Maintainers and admins bypass the restrictions on other branches and tags. Give the Mork account Write access, never Maintain or Admin. Rulesets are available on public repositories with GitHub Free; private repositories require an eligible paid plan. [GitHub ruleset reference](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).
5. Label an issue `mork` using an account with at least triage access.

Rulesets change access for all Write-role contributors, so review those restrictions for your repository before applying them. Reapplying updates rulesets with the same name.

## 6. Slack

1. Create an app from [`packages/sources/slack-app-manifest.yaml`](../packages/sources/slack-app-manifest.yaml). Replace the example request URL with `slack_events_url` before enabling event subscriptions.
2. Store its signing secret and bot token, map channels in `slack_channels`, set `jira_base_url` and `jira_email`, and apply.
3. Invite the bot and mention it: `@mork add …` or `@mork implement PROJ-123`.

Slack retry deliveries resume their original question. Answers are durably recorded before the workflow resumes. Only the requester can answer. An unconfigured signing secret rejects requests even if Slack resources exist.

## Operating

| Task | Command |
| --- | --- |
| Follow the newest execution | `mise run e2e:watch` |
| Export calibration decisions | Set `MORK_TIMELINE_TABLE`, then `mise run timeline:export -- recommendation > data.jsonl` |
| Remove stored GitHub credentials | `mise run secrets:put -- --delete-github`, then apply again |

Removing Secrets Manager values does not revoke the tokens in GitHub. Revoke each token through GitHub settings before replacing it. The removal task recreates the secrets with placeholders and new ARNs, so reapply the stack.

Logs live in `/ecs/<name>/stations`, `/aws/lambda/<name>_*`, the state machine's log group, and your OTLP destination when configured. An exhausted Handover retry fails the execution as `Mork.HandoverFailed`; inspect the execution history for the notification or cleanup error.

Both public webhook URLs need `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`. The latter is restricted to requests via Function URL. The module supplies both permissions. [AWS Function URL authorization](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).
