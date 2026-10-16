# Configured workflows

One Slack app serves all workflows. Terraform creates a Standard Step Functions
state machine for each entry in `workflows`. The machines share the ECS cluster,
runner and Lambda images, artifact bucket and Slack endpoint.

`workflows.development` configures the original Plan/Build/Check workflow. Its
operations keep hidden tests, the before/after gate, reviewer, draft PR delivery
and the Build/Check retry loop. Terraform compiles their order, question paths
and retry paths into the development state machine. The existing resource
addresses stay in place. If omitted, development uses the
[shipped definition](../packages/contracts/src/development.json); the local
runner uses the same definition.

Other workflow entries use agent, command and approval steps without Git or Jira.
The module still provisions development infrastructure and references its GitHub
secrets. Generic executions receive only their explicitly configured secrets.

## Development configuration

In `infra/aws/examples/basic`, the whole original workflow can be selected with:

```hcl
workflows = {
  development = jsondecode(file("${path.module}/../../../../packages/contracts/src/development.json"))
}
```

For your deployment, copy that JSON into your configuration directory or define
it directly in Terraform. Instructions can come from `file(...)`:

```hcl
workflows = {
  development = {
    description = "Implement software changes and open a reviewed draft PR."
    steps = [
      {
        name = "design", kind = "plan"
        instructions = file("prompts/analyst.md")
        tools = ["read", "bash", "grep", "find", "ls"]
        attempts = 2, timeout_seconds = 7200
        capacity = "spot", spot_retries = 4
        allowed_domains = ["github.com", "*.githubusercontent.com", "registry.npmjs.org"]
      },
      {
        name = "implement", kind = "build"
        instructions = file("prompts/implementer.md")
        attempts = 3, timeout_seconds = 7200
        capacity = "spot", spot_retries = 2
        allowed_domains = ["github.com", "registry.npmjs.org"]
      },
      {
        name = "verify", kind = "check"
        instructions = file("prompts/reviewer.md")
        tools = ["read", "bash", "grep", "find", "ls"]
        timeout_seconds = 7200
        capacity = "spot", spot_retries = 4
        allowed_domains = ["github.com", "registry.npmjs.org"]
      }
    ]
    questions = { max = 3, timeout_seconds = 259200 }
    fixes = { rounds = 2, attempts = 2 }
    repairs = { rounds = 3 }
    total_build_attempts = 8
    delivery = { kind = "draft_pr", step = "verify" }
  }
}
```

Development requires exactly Plan, Build and Check in that order. These are
operations with fixed output contracts and credential boundaries. `attempts` in
Plan bounds total submissions within the same session, including the first;
in Build it bounds the Build/Check loop. Check
runs once per Build attempt. `fixes` bounds post-PR fix rounds and their Build
attempts. `repairs.rounds` bounds how often reviewer findings go back to Build
before the PR (default 3, 0 turns repairs off); each repair adds a Build attempt
of its own. Step names, prompts, optional model overrides, tools and trusted Pi
extensions are configurable. `submit_result`, Build's `verify`, and Slack's
`ask_human` remain available when the operation requires them. Instructions append
to Pi's system prompt. Gate policy still comes from the base commit's
`.mork/config.toml`.

`total_build_attempts` optionally caps Build attempts across the initial run,
reviewer repairs and later CI fixes. Without it, the pinned limit is the finite
envelope `build attempts + repair rounds + fix rounds × (fix attempts + repair
rounds)`. Fix claims reserve their allowance atomically with ownership; unused
reservations are retained. Explicitly resuming a task does not replenish its
budget. This counts attempts, not tokens or cost.

Handover closes automation in the task's stored PR record before stopping work
or publishing the takeover PR. CI and ordinary review events cannot restart a
handed-over task. A user with write access can explicitly comment `@mork resume`
to resume within the remaining budget. The `needs-human` label displays this state;
the conditional storage update decides ownership. A repeated completed Handover
does not publish another notification.

CI fixes collect all check runs and commit statuses for the current head. Pending
checks defer the claim without spending a fix round. A later completed suite,
including a successful one, wakes collection again. The same head cannot claim
another CI fix round, and a stale event cannot start a fix run for a newer head.
Completed runs without a verdict (cancelled, awaiting approval, stale, startup
failure) are reported as inconclusive and start nothing.

Automatic wakeups currently come from completed check suites. A legacy commit
status that finishes after the bounded collection window does not wake Mork by
itself; an explicit authorized comment can request another check. Unknown queued
suites remain pending even before they create a check run. Investigate a suite
that never completes rather than treating it as successful.

For Slack tasks, the trusted Lambda refreshes incoming Jira `Blocks` links before
Plan and Build, including after a question resumes, and before retry or delivery.
An unresolved or unknown blocker stops work. A Jira Done status does not prove
that its implementation is present in the checkout. Merge prerequisite changes
before starting dependent tasks, and verify the required behavior against that
base revision. Mork does not schedule or merge dependencies automatically.

A completed Step Functions execution can represent either verified delivery or
Handover. A takeover draft PR preserves unfinished work; it is not evidence that
its acceptance checks passed.

Each container step gets its own `allowed_domains`, including the gate's setup,
tests and checks. The proxy adds the LLM host. It does not add GitHub or package
registries to custom definitions; list the services the step needs. An empty list
allows only the LLM host through the proxy. With the default `egress_enforce =
false`, unexpected hosts are logged; enabling it blocks those requests through
the proxy. It does not prevent direct network access around the proxy.

The old module-level `phase_seconds`, `spot_attempts`, `answer_seconds` and
`egress_allow` settings have moved into this definition: use step
`timeout_seconds`, `spot_retries`, `allowed_domains` and
`questions.timeout_seconds` respectively.

## Routing

Slack acknowledges a signed event after enqueueing an asynchronous invocation of
the same Lambda. A channel with one allowed workflow selects it directly;
Start still triages the task and resolves its Jira issue. The original Slack
request is retained alongside the Jira description, including supplied context
and constraints. With multiple allowed
workflows, the worker asks Jev to select one, including messages that explicitly
name one. Jev receives the request, workflow descriptions and the channel's
allowed options. `default_workflow` is a hint to Jev; it never acts as a fallback
when routing fails.

For channels with multiple workflows, below `routing_confidence` or when Jev
chooses `_clarify`, the worker asks the
requester in the original thread. Jev evaluates their reply together with the
original request. No workflow starts until there is an allowed, confident choice.
An unavailable or invalid Jev response reports routing failure and starts nothing.
The router validates the chosen name and obtains its ARN from trusted
configuration. The model cannot provide an ARN or expand the channel allowlist.

Configure `decision_providers = [{ name = "jev" }]` and create the existing
`<secret_prefix>/jev-api-key` secret. Jev is mandatory when Slack channels are
configured. Other decision providers may still serve the development workflow;
they do not route Slack requests.

The event's first accepted route is recorded before `StartExecution`. Retries use
that same ARN and original input, even after a configuration change. Decision
traces are stored under `threads/events/` alongside the binding.

## Terraform example

Add these arguments to the Mork module. This example analyzes numbers in the
request, verifies the total with a command and delivers the checked report.

```hcl
decision_providers = [{ name = "jev" }]
routing_confidence = 0.85

workflows = {
  analysis = {
    description = "Analyze numbers supplied in a request and return a checked report."
    steps = [
      {
        name = "analyze"
        kind = "agent"
        instructions = <<-TEXT
          Extract the numbers the requester wants added. Use only supplied data.
          Return the numbers, their total and a short report. Do not invent inputs.
        TEXT
        tools = ["read", "bash"]
        output_schema = jsonencode({
          type = "object"
          required = ["numbers", "total", "report"]
          additionalProperties = false
          properties = {
            numbers = { type = "array", minItems = 1, items = { type = "number" } }
            total   = { type = "number" }
            report  = { type = "string" }
          }
        })
      },
      {
        name = "validate"
        kind = "command"
        inputs = ["analyze"]
        command = ["node", "-e", <<-JS
          const fs = require('node:fs');
          const { inputs } = JSON.parse(fs.readFileSync(process.env.MORK_INPUT_FILE, 'utf8'));
          const result = inputs.analyze;
          const total = result.numbers.reduce((a, b) => a + b, 0);
          if (Math.abs(total - result.total) > 1e-9) throw new Error('Incorrect total');
          fs.writeFileSync(process.env.MORK_OUTPUT, JSON.stringify({ report: result.report, total }));
        JS
        ]
        output_schema = jsonencode({
          type = "object"
          required = ["report", "total"]
          properties = { report = { type = "string" }, total = { type = "number" } }
          additionalProperties = false
        })
      }
    ]
    delivery = { kind = "report", step = "validate" }
  }
}

slack_channels = {
  C0123456789 = {
    default_workflow  = "analysis"
    allowed_workflows = ["analysis"]
  }
}
```

`instructions = file("instructions/analysis.md")` and
`output_schema = file("schemas/analysis.json")` work as well. Adding another entry
creates another machine and offers it to Jev in channels that allow it.
`workflow_arns` exports the name-to-ARN mapping.

## Steps and artifacts

Steps run in list order. Names must be unique; `inputs` may refer only to preceding
steps. Each step runs in a fresh container with only the selected predecessor JSON
results. Files in an agent workspace do not transfer to the next step.

| Kind | Behavior |
| --- | --- |
| `agent` | Runs Pi with the supplied instructions, model, tool list and output schema. |
| `command` | Runs an argv array as UID 10001; writes its JSON result to `MORK_OUTPUT`. Nonzero exit fails the step. |
| `approval` | Shows selected inputs and instructions in Slack. Only the original requester can approve or reject. |

Agent and command results are validated using synchronous JSON Schema draft-07
with Ajv strict mode, without type coercion. Schema validity does not establish
that a calculation or dashboard is correct; add commands that check the actual
artifact. A schema can require `passed` to equal `true` when a reviewer must reject
an invalid result.

`MORK_INPUT_FILE` contains `{request, inputs}`. `MORK_IDEMPOTENCY_KEY` is stable for
the workflow, execution and step. Results and redacted agent sessions live at
`tasks/workflows/<workflow>/<execution>/steps/<step>/`. Successful steps upload
their result before sending the callback; a retry skips a recorded success.
An external write can succeed before the artifact is recorded, so publication
commands must also use the idempotency key or an idempotent update operation.

`timeout_seconds` defaults to 7200 and ranges from 301 to 86400. `retries` defaults
to zero, with at most three retries of that step. `capacity` defaults to
`on_demand`. Set `capacity = "spot"` to retry interruptions and capacity failures
up to `spot_retries` per error category (default four, range zero to eight), then
fall back to on-demand for that step. Failure stops the sequence and leaves a
failed execution. Each later step starts with its own capacity setting.

For an approval, reply `@mork approve` or `@mork reject`. Rejection and timeout
stop subsequent steps. An approved step produces `{approved: true, by: ...}` for
later inputs. Put approval immediately before a command that publishes to an
external service, and put that service's write credential only on that command.

`delivery` currently supports `report`: it posts the chosen result's `report`
string, or a JSON preview, into the original Slack thread. The full result links
to S3's authenticated console. It does not create a public artifact URL.

## Tools and credentials

`tools` selects Pi tools. The defaults are read, bash, edit, write, grep, find and
ls; `submit_result` is always available. These lists control tools exposed to the
model, not filesystem or network permissions. Bash can write files even in a
step that omits Pi's write tool.

Use `runner_image` for additional installed clients and `extensions` for trusted
Pi extension paths in that image. The image must preserve the runner entrypoint,
Node/Pi, Linux users 10001/10002 and root-owned `/work`. Configured steps share the
egress sidecar; each step’s `allowed_domains` sets its proxy allowlist alongside the LLM host.

`environment` supplies nonsecret variables. `secrets` maps variable names to
Secrets Manager ARNs. ECS injects only the named step secrets; the runner grants
them to that step's process and redacts their values from outputs and sessions.
The LLM key stays in the egress sidecar. The agent and commands receive no runner
AWS credentials. Each step has its own task and execution roles; artifact access
is scoped to its workflow, own outputs and selected predecessor outputs across
runs of that workflow. These generic roles do not provide per-execution IAM
isolation.

## Local execution

Save a workflow's `steps` and `delivery` as a JSON document, using JSON objects or
JSON strings for `output_schema`. Run on Linux as a non-root user:

```sh
mise run workflow:configured -- --trusted --definition workflow.json \
  --workflow analysis --task "Add 20 and 22" --output /tmp/mork-analysis \
  --model MODEL --llm-url URL --pi /absolute/path/to/pi
```

Command-only workflows need no model or LLM URL. Set `MORK_LOCAL_API_KEY` when
needed. Named step secrets come from matching environment variables. Local tools
run as your user; use trusted definitions. Resume with `--trusted --resume DIR`
and the same model options. The saved definition remains the run's configuration.
`workflow:local` runs development with the shipped definition. Pass
`--definition development.json` to use your own steps and retry budget. Resume
uses the saved definition, even after that JSON file changes. Local runs use the
host network; `allowed_domains` configures the AWS sidecar, not a local firewall.

For each configured reference repository, pass `--reference NAME=/absolute/local/repo`
to `workflow:local`, for example `--reference reference-data=/home/me/workspace/reference-data`.
The local repository must contain the configured commit. Only selected paths from
that commit are exported; working-tree edits are ignored. No GitHub credentials
or remote reference fetches are used. Mappings are saved with the run and reused
on resume; supplying different mappings on resume is rejected.

`mise run check` covers routing against local HTTP adapters and mock AWS plans.
`mise run images:check` also runs the real compiled entrypoint and Pi against
loopback service fixtures in Docker with networking disabled. It proves artifact
handoff, schema correction, credential separation and callback recovery without
calling AWS, Slack or a real model service.

The optional `runner_image` must include an immutable `@sha256:` digest. HCL validates step settings and JSON syntax; deployment preflight validates the rendered task definitions with the same Zod and strict Ajv parsers used by the runner. Bootstrap failures also send a task failure callback immediately. Container timeouts are between 301 and 86400 seconds. Human approval waits may be between 1 and 31536000 seconds, within the overall Standard execution lifetime; development questions have their separately configured timeout.

Instructions are limited to 24 KiB of UTF-8. Deployment preflight validates the full serialized container configuration against a 48 KiB project budget, including schemas, environment and JSON escaping. It also parses the rendered Slack routes and full workflow definitions, including approval steps. These checks reject oversized or inconsistent configuration before apply.

Generic step timeouts go to failure cleanup; `retries` does not retry `States.Timeout`. Explicit completed failures and Spot interruption/capacity retries retain their configured budgets. The complete execution budget, including all approval waits and retries, must fit within one year. S3 retention must cover that budget and a 14-day recovery reserve.
