# Configuration

Nothing about a deployment is hard-coded. A deployment is configured in three places:

1. the Terraform module's variables ([`infra/aws/variables.tf`](../infra/aws/variables.tf)), which set the environment of every Lambda and container;
2. secrets in AWS Secrets Manager, created by [`scripts/aws-secrets.sh`](../scripts/aws-secrets.sh);
3. `.mork/config.toml` and `AGENTS.md` in each repository Mork works on.

## Terraform variables

Required: `vpc_id`, `vpc_cidr_block`, `vpc_private_subnet_ids`, `repo_allowlist`, `llm_base_url`, `model`. Everything else has a default; see `variables.tf` for descriptions.

| Variable | Default | Purpose |
| --- | --- | --- |
| `name` | `mork` | Prefix of every resource |
| `environment` | `dev` | Environment label on logs |
| `llm_base_url`, `model` | — | The OpenAI-compatible LLM |
| `secret_prefix` | `mork` | Secrets Manager names are `<prefix>/<name>` |
| `github_auth_mode` | `token` | `app` uses a GitHub App installation; `token` uses a static token |
| `decision_providers` | `[]` | Development decision panel; Jev selects between multiple Slack workflows; a single workflow is selected directly |
| `repo_allowlist` | — | Repositories Mork may work on |
| `slack_channels` | `{}` | Channel ID → allowed workflows and default hint; development also needs repo and Jira project |
| `workflows` | `{}` | [Development and generic steps, prompts, domains, capacity, retry policy and delivery](workflows.md) |
| `routing_confidence` | `0.85` | Minimum Jev confidence before starting a workflow |
| `jira_base_url`, `jira_email` | `""` | Jira Cloud site and service account for Slack tasks |
| `station_size` | 2048 CPU, 8192 MiB, 40 GiB | Fargate size of a phase container |
| `supervise_seconds` | 300 | Longest time between two supervision questions to the decision model; signals ask earlier |
| `egress_enforce` | `false` | Block instead of log requests outside the allowlist |
| `otlp_endpoint`, `otlp_cidr_block` | `null` | OTLP/HTTP collector for the live log, Lambda events and the egress audit; with `otlp_cidr_block` the collector is inside your network and the Lambdas join the VPC to reach it |
| `log_destination` | `cloudwatch` | `cloudwatch`: log groups for Lambdas, containers and Step Functions. `otlp`: logs only to `otlp_endpoint`, no log groups |
| `log_retention_days` | 30 | CloudWatch log retention, with `log_destination = "cloudwatch"` |
| `alarm_actions` | `[]` | SNS topics for Slack and workflow failure alarms; empty creates no alarms and no failure queue |
| `otel_resource_attributes` | `""` | Extra attributes on the live log |
| `grafana_url`, `grafana_loki_uid` | `null`, `loki` | Link to the live log in Grafana and its Loki data source |
| `bucket_expiration_days` | 120 | Retention of task outputs and sessions |
| `image_digests` | `{}` for ECR bootstrap only | Required runner, egress and lambda sha256 digests for full apply |
| `tags` | `{}` | Extra resource tags, merged with Service and Environment |

## Secrets

All secrets are `<secret_prefix>/<name>`. `scripts/aws-secrets.sh` reads each value from an environment variable and never prints it; unset ones get a placeholder the first time so the stack can be applied.

| Secret | Variable for the script | Held by | Scope |
| --- | --- | --- | --- |
| `llm-api-key` | `MORK_LLM_API_KEY` | egress sidecar, steps Lambda | the LLM API |
| `github-token` | `MORK_GITHUB_TOKEN` | Lambdas, runner and Build egress sidecar | Contents read/write, issues and pull requests read/write, checks and Actions read; no Workflows write |
| `github-app` | `MORK_GITHUB_APP` | Lambdas and trusted runners | JSON containing App ID, installation ID and the RSA private key; used instead of `github-token` |
| `webhook-secret` | generated | GitHub intake | webhook signatures |
| `jev-api-key`, `openai-api-key` | `JEV_API`, `OPENAI_API_KEY` | steps Lambda, runner; Jev also in the Slack worker | decision models; Jev required for Slack |
| `slack-signing-secret`, `slack-bot-token` | `MORK_SLACK_SIGNING_SECRET`, `MORK_SLACK_BOT_TOKEN` | Slack Lambda, steps, runner | Slack source (optional) |
| `jira-api-token` | `MORK_JIRA_API_TOKEN` | Slack Lambda, steps | Jira tracker (optional) |

Choose one GitHub credential type. Do not give the identity admin permissions, Workflows write permission or ruleset bypass.

### GitHub App

Set `github_auth_mode = "app"` in the deployment and store this JSON in `<secret_prefix>/github-app`:

```json
{"appId":"12345","installationId":67890,"privateKey":"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"}
```

Create the App under the organization that should own it. Set Contents, Issues and Pull requests to read/write, and Checks and Actions to read-only. Install it on selected repositories that match `repo_allowlist`. The App ID is in the App's General settings; the installation ID is the number in its installation settings URL. Generate an RSA private key in the App's General settings. The OAuth client secret is not used.

`MORK_GITHUB_APP` passes this JSON to `mise run secrets:put`, which validates it before writing any secrets. Configure no `MORK_GITHUB_TOKEN` in this mode. Terraform references the secret ARN, never its value.

Lambdas and trusted runners sign an App JWT and request an installation token scoped to the task repository. Tokens are cached and refreshed five minutes before expiry. Concurrent requests for the same repository share one mint request; renewal failures propagate rather than silently reusing a stale token. Warm Lambdas fetch a current token for each GitHub API call, and runners do so before each authenticated fetch or remote-head check.

Reference repositories configured on the task repository's default branch use separate installation tokens with only `contents: read`. The installation must already include those repositories. Adding a repository to an App installation does not by itself deliver its files to a worker. The trusted runner fetches the pinned revision and selected text paths, then publishes files and a SHA-256 manifest outside the candidate checkout. Credentials and Git metadata stay outside the worker's inputs. Static-token deployments cannot downscope an existing token; their trusted runner still exposes only the exported files.

In Build, the trusted runner also maintains `/mork-egress/github-token`, a root-owned file with mode `0600`. The proxy reads it with a 30-second cache and injects authentication only for the task repository's Git URLs. The proxy receives no App private key. The runner refreshes the file during long phases and stops the agent on renewal failure. Plan and Check do not grant proxy Git authentication. Every issued token is included in session/log redaction.

Installations are configured per deployment; automatic installation discovery is not implemented. Rotating the App private key requires updating the secret and restarting consumers so cached configuration is replaced. App webhooks may use the existing intake URL and webhook secret, or repository webhooks may remain configured separately.

### Static token

The default `github_auth_mode = "token"` supports one fine-grained machine-account token restricted to the repositories in `repo_allowlist`, with the permissions listed above. All consumers share its permissions. The runner holds it outside the agent's environment; only Build's proxy injects it into requests for the task repository. A manually supplied short-lived token still needs manual renewal.

## Repository configuration

Each repository needs `.mork/config.toml` on its default branch. Mork always reads it from the base commit, never from the agent's branch.

```toml
test = "npm test"                 # required
# setup = "npm ci"                # install before the tests
# checks = ["npm run lint"]       # further commands; verify and the gate run them
protected_paths = []              # a change here sends the task to a person
test_paths = ["test/", "tests/"]  # existing tests the agent must not change (default)

[hidden_tests]
dir = "test-hidden"               # where the gate writes the hidden tests
command = "node test-support/mork.mjs {file}" # repository-owned adapter; must contain {file}
file_suffix = ".json"             # data format supported by that adapter
protocol = "mork-v1"
runtime_paths = ["test-support/mork.mjs", "package.json", "package-lock.json"]
```

Rules for the agent go in `AGENTS.md`: the root file and files in subdirectories (a subdirectory's rules reach the agent before it first edits a file there).

### Reference inputs

Configure only required text paths at an immutable revision:

```toml
[[reference_repositories]]
name = "legacy"
repo = "your-org/legacy-service"
sha = "0123456789abcdef0123456789abcdef01234567"
paths = ["src/loader.py", "schemas"]
```

The runner fails before the station starts if a selected path or revision is unavailable, or if a selected entry is a symlink, submodule or binary file. Exports are bounded to 10,000 files and 50 MiB; narrow the selection instead of truncating contracts. Every station receives a compact manifest location. Requester answers are separate JSON files with their original question, rather than repeated large blocks in each prompt. Repeated preparation validates the manifest schema, identity, relative paths and published hashes, rejecting symlinked cache entries, and resumed sessions receive the same paths for unchanged inputs.

### Acceptance verification

For executable acceptance checks, configure a repository-owned adapter with `hidden_tests.protocol = "mork-v1"` and list its trusted code, configuration and dependencies in `hidden_tests.runtime_paths`. Changes to these paths are a separately reviewed prerequisite, not part of the candidate implementation. The adapter must prepare the same environment used for its checks and compare public behavior with the supplied expectations. A free-form test script reporting its own success is not a trusted adapter.

The adapter's last line is `MORK_RESULT` followed by JSON containing `status`, `reason` and `tests`. Status and exit code must agree: `pass`/0, `behavior_failure`/1, `execution_failure`/3, `inconclusive`/4. An import, startup or setup failure remains an execution failure even when wrapped in `AssertionError`. Legacy commands without this protocol cannot certify a baseline, whether they exit zero or nonzero. Existing repositories must provide an adapter before starting new tasks. A legacy zero exit in an after-gate remains a pass, but cannot replace the missing baseline evidence.

For a certified pass or behavior failure, `tests.readiness.ready` must be `true` and `tests.cases` must contain completed cases with `id`, `criteria` and `status`. Every criterion declared for the hidden file must appear in a completed case. All cases must pass or report a behavior failure, and the aggregate status must agree with them. Missing or incomplete evidence is an execution failure, even when the process exits zero. This verifies execution and coverage declarations; review still has to establish that the cases actually test the requested behavior.

Numbered author criteria require executable verification by default. An author may explicitly prefix an evidence-only criterion with `[evidence]`, for example `AC4: [evidence] Document the recovery command`. The analyst cannot add that exemption. The runner supplies the author's exact text and validates coverage within the same planning session. Existing passing behavior is retained as regression evidence rather than forced to fail.

A changed oracle, runtime or acceptance contract invalidates the baseline/candidate comparison. After implementation starts, invalid verification is handed over for Plan-owned repair and independent review; the implementer cannot rewrite hidden expectations to make a result pass. Hashes establish identity, not the semantic correctness of an assertion.

Repository setup runs before a new or resumed station starts. Verification diagnostics retain command identity, checkout SHA, working directory and redacted output outside the checkout. Capture is bounded to 64 MiB per command; exceeding it marks the diagnostic incomplete and prevents a successful verification. The prompt shows a short excerpt and the saved artifact location.

### Prepared repository runtime

Repository commands are toolchain-independent. Mork runs the `setup`, `test`, `checks` and hidden-test commands configured by the repository; it does not require mise, uv, a particular language or a particular package manager. The repository supplies any additional tools through its setup or prepared image. Mise manages development of Mork itself and is not installed in the base worker image.

The operator may configure development `runner_image` as a repository-owned image with an immutable `@sha256:` digest. Development workers run on `linux/arm64`. Start snapshots that image identity and the revision-qualified Plan, Build and Check task definitions into the task's Brief. Initial launches, Spot fallback, Ask/resume and later fix runs use those saved revisions; a new deployment cannot replace them. Existing cloud tasks without a runtime pin must be restarted as new tasks rather than silently adopting the current image. Retain the pinned images and task-definition revisions while their tasks can resume.

A prepared image contains `/opt/mork-runtime/manifest.json`:

```json
{
  "schema": 1,
  "platform": "linux/arm64",
  "base_mork_digest": "sha256:<64 lowercase hexadecimal characters>",
  "inputs": {
    ".mork/config.toml": "<64 lowercase hexadecimal characters>",
    "package-lock.json": "<64 lowercase hexadecimal characters>"
  }
}
```

Include every lockfile, tool configuration and setup input used to prepare dependencies. The manifest must include `.mork/config.toml`; every entry names a regular repository file and its SHA-256. The runner compares these hashes with Git blobs at the task's exact base SHA before worker setup, model sessions or gate commands. A later default branch or changed candidate working tree cannot change that comparison. The repository setup separately checks candidate inputs and imports, so stale prepared dependencies cannot hide a candidate dependency change. Local workers inside a prepared image perform the same manifest check. Native worker architecture must match the declared platform. The manifest records the parent Mork digest; trust in its contents comes from the operator-approved immutable image, not a repository-selected image or model claim.

## Environment reference

The Terraform module sets these; they are listed for running the code elsewhere. A variable `X` can be given as `X_SECRET_ID` (a Secrets Manager ARN or name) instead.

**Lambdas (`packages/steps`, `packages/sources`)**

| Variable | Purpose |
| --- | --- |
| `STATE_MACHINE_ARN` | Workflow the intakes start |
| `REPO_ALLOWLIST` | Comma-separated `owner/repo` |
| `WEBHOOK_SECRET`, `GITHUB_TOKEN` or `GITHUB_APP` | GitHub intake and steps; App credentials can use `GITHUB_APP_SECRET_ID` |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_CHANNELS` (JSON) | Slack source |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira tracker |
| `LLM_BASE_URL`, `LLM_API_KEY`, `MORK_MODEL` | One-shot LLM calls (clarifying questions, issue drafts) |
| `MORK_BUCKET`, `MORK_TIMELINE_TABLE`, `ECS_CLUSTER` | Storage and the cluster to stop tasks in |
| `MORK_GRAFANA_URL`, `MORK_GRAFANA_LOKI_UID` | Live-log link (optional; Loki data source uid defaults to `loki`) |

**Decision models (`packages/decision`)**

| Variable | Purpose |
| --- | --- |
| `JEV_API` (or `TYPESAFE_API_KEY`), `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL` | Jev |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_DECISIONS_MODEL` | OpenAI Decisions |
| `MORK_DECISION_PRIMARY` | Which configured provider decides; the others are recorded |

**Phase containers (`packages/runner`)**

| Variable | Purpose |
| --- | --- |
| `MORK_PHASE`, `MORK_BRIEF`, `MORK_TASK_TOKEN` | Set per run by Step Functions |
| `MORK_BUCKET`, `GITHUB_TOKEN` or `GITHUB_APP`, `MORK_MODEL`, `LLM_BASE_URL` | Inputs, GitHub authentication, LLM |
| `MORK_SUPERVISE_SECONDS` | Longest time between two supervision questions |
| `MORK_EGRESS_PROXY`, `MORK_EGRESS_CA` | Sidecar address and CA (defaults `http://127.0.0.1:3128`, `/mork-egress/ca.crt`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`, `MORK_ENV` | Live log (optional) |
| `PI_BIN`, `MORK_EXTENSIONS`, `MORK_WORK`, `MORK_AGENT_*`, `MORK_SANDBOX_*` | Image layout; defaults match the Dockerfile |

The runner sets these for the implementer's `verify` extension; they are internal to one container and need no configuration:

| Variable | Purpose |
| --- | --- |
| `MORK_VERIFY_LOG_DIR` | Where the extension keeps each verify invocation's raw step outputs and sidecars for the runner to collect (default `$HOME/out/verify`) |
| `MORK_VERIFY_PUBLISH_REQUIRED` | `1` makes the extension wait for the runner's redacted publication of every step before answering the model, so no raw path or unredacted tail is shown; unset in standalone runs |
| `MORK_VERIFY_PUBLISH_TIMEOUT_MS` | Bound on that wait, default 15 minutes; after it the tool fails closed. Tests set it low; deployments leave it unset |

**Egress sidecar (`images/egress`)**

| Variable | Purpose |
| --- | --- |
| `MORK_LLM_HOST`, `LLM_API_KEY` | Host the LLM key is injected for |
| `GITHUB_TOKEN`, `MORK_REPO` | Build only: the shared GitHub token, injected for this repository only |
| `GITHUB_TOKEN_FILE`, `MORK_REPO` | Build in App mode: root-owned renewable token file; no App private key in the proxy |
| `MORK_SERVICE_BINDINGS` | Deployment-generated lines `host=MORK_SERVICE_AUTH_<index>`. Each exact host is also added to the proxy allowlist. No wildcard, URL, port, duplicate host or overlap with GitHub/LLM. |
| `MORK_SERVICE_AUTH_<index>` | Complete Authorization header injected separately into the permitted phase’s sidecar. Never supply it to the runner. |
| `MORK_EGRESS_ALLOW` | This step’s allowed domains, comma separated; the LLM host is added automatically |
| `MORK_EGRESS_WARN` | `true` logs requests outside the allowlist, `false` blocks them |

Keep the operator-owned service list in the deployment repository, for example
`services.yaml`:

```yaml
services:
  - host: database.example.com
    authorization_secret: automation/database
  - host: api.example.com
    authorization_secret: automation/api
```

The deployment resolves those names to secret-store references, injects the
values only into the permitted sidecar, and renders `MORK_SERVICE_BINDINGS`.
The file and bindings contain no credentials. These are additional services;
the workflow's `allowed_domains` and LLM host remain in the effective allowlist.
`MORK_EGRESS_WARN=false` rejects other proxied hosts; `true` only logs them.
This replaces the single-service environment fields. Update the deployment and
proxy image together; the new proxy refuses the obsolete fields.

Service authorization replaces the request's Authorization header for that exact
host. The operator supplies the secret independently of repository/model input.
Use a TLS service endpoint and enforce data permissions and resource limits at
the service. Host matching does not constrain SQL, request paths or destination
ports. Other hosts receive no service credential. This is not network isolation:
a phase can bypass the proxy, but its processes do not receive the credential.

**Scripts**

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MORK_NAME` | all | Deployment name (default `mork`) |
| `MORK_ACCOUNT` | `deploy.sh` | Refuse to deploy into another AWS account |
| `MORK_ECR_PREFIX`, `MORK_FUNCTIONS` | `deploy.sh` | Override image repository prefix and Lambda names |
| `MORK_INFRA_DIR` | mise infra tasks | Configured root module, default `infra/aws/examples/basic` |
| `MORK_STATE_MACHINE` | `watch-execution.sh` | State machine to follow |
| `MORK_SECRET_PREFIX` | `aws-secrets.sh` | Secret name prefix |

Keep these in `mise.local.toml` (not committed), together with `AWS_PROFILE` and `AWS_REGION`.

## Run dashboards

With `otlp_endpoint` configured, Mork exports dashboard records through the existing
OTLP log connection. It creates no Prometheus metrics or additional state database.
Presentation colours belong to Grafana; Mork adds no ANSI colour codes to these records.

`run.snapshot` is a complete JSON record with `run_id`, repository, tracker issue,
title, requester ID and name, Slack permalink, status, `started_at`, `updated_at`,
`observed_at`, duration, optional usage, PR URL and review effort. Times are Unix
milliseconds. `updated_at` means the current status began; `observed_at` orders
records. A fix run gets a new run ID while retaining its task's tracker issue.

The existing `phase` events carry JSON records with `run_id`, `step_id`, phase,
attempt, start/end times, result, model and available station usage. `step_id` is
the ECS container task ID, also attached to live logs as `mork.step`. This keeps
Spot retries separate even when they share the same build attempt. The readable
phase message remains available as `mork.message`.

The steps Lambda exports waiting states after parking a question, completed states
after Decide opens or updates the PR, and handover states after notifying the
requester. Runners export running states as phases start. There is no separate
execution watcher or history replay. Manual aborts, execution timeouts and hard
crashes can leave the dashboard at its last reported status or phase. OTLP is
best effort; Step Functions remains the source of truth. These records are not a
durable run registry and do not backfill older executions.

Usage is reported per phase. Run-level totals remain unknown, represented by JSON
`null`, because Mork does not aggregate execution history. Missing station usage
also remains unknown. Resumed Pi sessions report only their new usage.
Decision-model usage is not included.

Slack names require the `users:read` bot scope in the app manifest and reinstalling
the app after adding that scope. Requester lookup failure retains the Slack user
ID and leaves the permalink empty without stopping the task.

The Grafana dashboards must select the latest whole record for each run or step,
including its null values, before counting or filtering status. The overview
shows runs updated within the selected time window. A long wait with no update
can fall outside that window; widen it when investigating an older run. The
source queries have a 5,000-record limit and are shared between panels. They are
intended for interactive inspection, not an exhaustive inventory or alert source.
