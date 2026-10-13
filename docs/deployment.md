# Deployment

Mork runs in one AWS account. You need a VPC with private subnets and outbound HTTPS through NAT, [mise](https://mise.jdx.dev), Git, Docker with Buildx, AWS CLI v2, GitHub CLI (`gh`), OpenSSL, and an OpenAI-compatible LLM endpoint. Mise installs the project's pinned Bun, Node, OpenTofu, jq and verification tools. Configure one GitHub App installation or machine-account token as described in [configuration](configuration.md#secrets).

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
MORK_INFRA_DIR = "/absolute/path/to/mork-deployment"
SETTINGS
mise run check
```

The frozen dependency install precedes all tests. `check` runs unit and local runtime tests, type checking, lint, shell and workflow checks, OpenTofu validation and mocked AWS plan tests. It does not contact an AWS account or deploy resources.

## 2. Secrets

```sh
MORK_LLM_API_KEY=... \
MORK_GITHUB_TOKEN=... \
mise run secrets:put
```

Add `JEV_API` or `OPENAI_API_KEY` for a decision model, and `MORK_SLACK_SIGNING_SECRET`, `MORK_SLACK_BOT_TOKEN`, `MORK_JIRA_API_TOKEN` for Slack. The script never prints values. Missing values become `unset` on the first run. This is a disabled placeholder, not a usable signing secret. Configure required credentials before starting tasks.

For a GitHub App, set `MORK_GITHUB_APP` to the JSON credential described in [configuration](configuration.md#github-app) instead of setting `MORK_GITHUB_TOKEN`, and set the deployment's `github_auth_mode = "app"`. The App's private key stays in Secrets Manager and trusted root/Lambda processes. Mork issues and renews repository-scoped installation tokens automatically, including Build's proxy token during long executions.

## 3. First deployment

Create a deployment root outside the source checkout, using [`infra/aws/examples/basic`](../infra/aws/examples/basic/main.tf) as a template. Keep its configuration, provider lockfile and state in your private deployment repository. Editing the tracked example inside Mork makes the image source dirty and deployment correctly refuses it.

Copy `main.tf` and `packages/contracts/src/development.json` into that external directory. In its module block set `source = "/absolute/path/to/mork/infra/aws"` and load development with `jsondecode(file("${path.module}/development.json"))`. Set actual subnets, repository and LLM configuration. The provider reads `AWS_REGION` from the environment. Expose the Mork module as `module.mork` for bootstrap and set `MORK_INFRA_DIR` to the external directory.

```sh
mise exec -- tofu -chdir=/absolute/path/to/mork-deployment init
mise run infra:bootstrap
mise run images:push
mise run infra:apply
```

The targeted bootstrap creates only the ECR repositories. `images:push` builds and uploads the three images without trying to update functions. Image upload writes `.mork-images.auto.tfvars.json` in the deployment root. Pass its `image_digests` variable into the Mork module as the example does. The full apply can then create Lambdas and task definitions from those immutable digests. Targeted apply is a first-install operation; ordinary changes use full `infra:apply`.

The module's dependency lockfile is committed. A separate deployment root needs its own committed lockfile and protected state backend. The example intentionally does not choose a production state backend for you.

## 4. Later deployments

```sh
mise run deploy
```

The script first rejects tracked and untracked changes, confirms all configured functions exist, and uploads the `runner`, `egress` and `lambda` images. It records all three digests in the deployment root and runs a saved Terraform plan through the runner's configuration and JSON schema validators before applying that exact plan. `infra:apply` uses the same validation. These commands apply the saved plan without a second Terraform confirmation; review infrastructure changes before invoking them and run them only when you intend to deploy. To upload without applying, use `images:push`.

Tasks use immutable image digests and pinned task-definition revisions. Step Functions calls a published version of the steps Lambda. Older task definitions remain active so existing executions can continue after an approval wait or retry. `current` is a discovery tag; deployed tasks never resolve it. `ALLOW_DIRTY=1` explicitly permits a local development build and gives it a distinct dirty tag. `MORK_ACCOUNT` rejects a different account. Names with underscores use hyphens for ECR, matching the module.

Keep old task revisions, Lambda versions, referenced images and their IAM roles until their executions end, including any runs you intend to redrive. Renaming/removing a workflow or step, changing its IAM policy, subnet or secret, or destroying the stack can still break existing executions. Drain affected workflows before those changes. The module installs no ECR expiration policy. Delete images only after confirming no retained execution, redrive, task revision or Lambda version needs their digests.

S3 retention must cover the full configured workflow budget, development repair rounds and a 14-day recovery reserve. Long approval waits require increasing `bucket_expiration_days`. Keep needed artifacts longer when extending recovery or leaving a PR open beyond that budget; lifecycle expiration does not inspect active executions.

Base images are pinned by digest in `Dockerfile`; workspace dependencies use `bun.lock` and Pi uses `images/runner/bun.lock`. Review base-image updates and rebuild periodically for security patches. Configure infrastructure changes with `mise run infra:apply`.

Production images contain bundled application code. The runner starts from `scratch`
with Node, npm, Bash, Git, Python, ripgrep and fd; it has no OS package manager.
Lambda uses a shell-free distroless base with the AWS runtime client, without the
redundant AWS SDK or local runtime emulator. The proxy uses its original static
binary on BusyBox. Build stages retain upstream license files in the final images.
Run `mise run images:check` to exercise these runtimes and enforce image size limits
without AWS or external network access.

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

Async Slack failures are retained for 14 days in the encrypted queue exposed by `slack_failure_queue_url`. Alarms cover Slack Lambda errors, visible failure records and failed/timed-out workflow executions. Set `alarm_actions` to your SNS topic ARNs to receive notifications; the empty default provides console alarms only. After fixing the cause, inspect the destination record and replay its `requestPayload` through the Slack worker. Preserve event IDs so the original route and answer receipts remain idempotent. Confirm success before deleting the queue record.

Logs live in `/ecs/<name>/stations`, `/aws/lambda/<name>_*`, the state machine's log group, and your OTLP destination when configured. An exhausted Handover retry fails the execution as `Mork.HandoverFailed`; inspect the execution history for the notification or cleanup error.

Both public webhook URLs need `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`. The latter is restricted to requests via Function URL. The module supplies both permissions. [AWS Function URL authorization](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html).

## Migration from the original configuration

`phase_seconds`, `spot_attempts`, `answer_seconds` and `image_tag` are replaced by `workflows.development` and `image_digests`. Copy the shipped [development JSON](../packages/contracts/src/development.json) and configure each step's timeout, attempts, capacity, Spot retries, prompts and domains. Configure human waits under `questions` and repair rounds under `fixes`.

Expose `variable "image_digests" { type = map(string) }` in your deployment root and pass it as `image_digests = var.image_digests` to `module.mork`. Run `images:push` to record the three digests, review the changes, then `infra:apply`. The built-in development resource addresses stay the same. Existing executions created before pinned versions and retained revisions need to finish before migration; an update cannot retroactively change their captured definitions.

## Recovering a failed run

Inspect execution history first, then the station/Lambda logs and the task's S3 prefix. Runner bootstrap failures send `StationError` immediately. A generic workflow's `status.json` retains the original failure even if ECS cleanup or Slack notification also fails. The native execution remains failed when terminal notification retries are exhausted.

For a PR repair, `pr.json` is the authoritative reservation with its owning execution, round, highest completed attempt and the current owner's reserved attempt ceiling. Retry a failed Start to resume the same round. Once that execution is terminal, a new authorized trigger may reserve the next round above that ceiling, so it cannot overwrite attempts whose final bookkeeping was interrupted. Do not manually delete an active reservation. Old `fix/<round>.json` objects are no longer read. Exhausted repair budgets require a person to finish the PR.

For a timeout during a question, confirm the execution and pending task token before retrying or redriving. A late answer cannot reopen an expired token. For cleanup failure, confirm and stop leftover ECS tasks before removing artifacts or retained versions. Timeouts of generic container steps go through failure cleanup instead of launching an overlapping retry. Confirmed Start notifications are recorded and skipped on retry. A lost Slack response or an interrupted receipt write can still duplicate a message; notification retries preserve the execution's original error.

### Migrating GitHub credentials

Mork uses one GitHub token for clone, push and pull requests. Give the existing `github-token` the combined permissions listed in [configuration](configuration.md#secrets), rebuild all images and apply the updated task definitions together. The runner and Build proxy now read `GITHUB_TOKEN`. Retained executions still need their original images and secrets. Remove the old `github-read-token` and `github-push-token` secrets only after those executions and intended redrives have finished.
