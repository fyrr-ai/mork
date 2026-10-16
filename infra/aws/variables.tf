variable "name" {
  description = "Name of this deployment; prefixes every resource (state machine, cluster, functions, roles, log groups, images)."
  type        = string
  default     = "mork"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_-]{1,30}$", var.name))
    error_message = "name must be 2-31 lowercase letters, digits, - or _, starting with a letter."
  }
}

variable "environment" {
  description = "Environment label on logs (deployment.environment.name), e.g. dev, test, prod."
  type        = string
  default     = "dev"
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days, with log_destination cloudwatch."
  type        = number
  default     = 30
}

variable "vpc_id" {
  description = "VPC for the phase tasks. Its private subnets need outbound HTTPS (NAT)."
  type        = string
}

variable "vpc_cidr_block" {
  description = "CIDR of that VPC; the tasks may query its DNS resolver."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr_block, 0))
    error_message = "vpc_cidr_block must be a valid CIDR."
  }
}

variable "vpc_private_subnet_ids" {
  description = "Private subnets for the phase tasks."
  type        = list(string)

  validation {
    condition     = length(var.vpc_private_subnet_ids) > 0 && alltrue([for id in var.vpc_private_subnet_ids : can(regex("^subnet-[a-f0-9]+$", id))])
    error_message = "Provide at least one valid private subnet ID."
  }
}

variable "repo_allowlist" {
  description = "owner/repo names Mork may work on; every other repository is ignored at intake."
  type        = list(string)

  validation {
    condition     = length(var.repo_allowlist) > 0 && alltrue([for repo in var.repo_allowlist : can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo))])
    error_message = "repo_allowlist must contain owner/repo names."
  }
}

variable "llm_base_url" {
  description = "Base URL of an OpenAI-compatible chat completions API, e.g. https://api.example.com/v1. Its key is the secret <secret_prefix>/llm-api-key."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^[:space:]]*)?$", var.llm_base_url))
    error_message = "llm_base_url must be an HTTPS URL without embedded credentials."
  }
}

variable "model" {
  description = "Model id passed to that API for planning, coding and review."
  type        = string

  validation {
    condition     = length(trimspace(var.model)) > 0
    error_message = "model must not be empty."
  }
}

variable "secret_prefix" {
  description = "Secrets Manager names are <secret_prefix>/<name> (llm-api-key, github-token or github-app, webhook-secret, slack-*, jira-api-token, <provider>-api-key)."
  type        = string
  default     = "mork"
}

variable "github_auth_mode" {
  description = "GitHub credential type: app uses a JSON installation credential; token uses a static token."
  type        = string
  default     = "token"

  validation {
    condition     = contains(["app", "token"], var.github_auth_mode)
    error_message = "github_auth_mode must be app or token."
  }
}

variable "decision_providers" {
  description = "Decision models to ask (name jev or openai, optional base_url and model); the first decides, the others are recorded for comparison. Empty: no decision model, every PR gets careful review. Each needs the secret <secret_prefix>/<name>-api-key."
  type        = list(object({ name = string, base_url = optional(string), model = optional(string) }))
  default     = []

  validation {
    condition     = alltrue([for p in var.decision_providers : contains(["jev", "openai"], p.name)])
    error_message = "decision_providers may only name jev and openai."
  }

  validation {
    condition     = length(distinct([for p in var.decision_providers : p.name])) == length(var.decision_providers)
    error_message = "decision_providers may name each provider once."
  }
}

variable "image_digests" {
  description = "Uploaded runner, egress and lambda sha256 digests. Required for full apply; image upload writes these into the deployment root."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for name, digest in var.image_digests :
      contains(["runner", "egress", "lambda"], name) && can(regex("^sha256:[0-9a-f]{64}$", digest))
    ])
    error_message = "image_digests accepts runner, egress and lambda with sha256:<64 lowercase hex digits>."
  }
}

variable "station_size" {
  description = "Fargate size of a phase container: vCPU units, memory MiB and ephemeral storage GiB."
  type        = object({ cpu = optional(number, 2048), memory = optional(number, 8192), storage_gib = optional(number, 40) })
  default     = {}

  validation {
    condition = contains(flatten([
      [for memory in [512, 1024, 2048] : "256:${memory}"],
      [for memory in range(1024, 4097, 1024) : "512:${memory}"],
      [for memory in range(2048, 8193, 1024) : "1024:${memory}"],
      [for memory in range(4096, 16385, 1024) : "2048:${memory}"],
      [for memory in range(8192, 30721, 1024) : "4096:${memory}"],
      [for memory in range(16384, 61441, 4096) : "8192:${memory}"],
      [for memory in range(32768, 122881, 8192) : "16384:${memory}"],
    ]), "${var.station_size.cpu}:${var.station_size.memory}")
    error_message = "station_size cpu and memory must be a supported Fargate combination."
  }

  validation {
    condition     = var.station_size.storage_gib >= 21 && var.station_size.storage_gib <= 200 && var.station_size.storage_gib == floor(var.station_size.storage_gib)
    error_message = "station_size storage_gib must be a whole number from 21 to 200."
  }
}

variable "supervise_seconds" {
  description = "Longest time between two questions to the decision model about a running LLM station; signals such as repeated tool calls ask earlier."
  type        = number
  default     = 300

  validation {
    condition     = var.supervise_seconds >= 1 && var.supervise_seconds == floor(var.supervise_seconds)
    error_message = "supervise_seconds must be positive whole seconds."
  }
}

variable "slack_channels" {
  description = "Slack channel routing; development additionally needs a repository and Jira project."
  type = map(object({
    repo              = optional(string)
    jira_project      = optional(string)
    jira_components   = optional(list(string), [])
    default_workflow  = optional(string, "development")
    allowed_workflows = optional(list(string), ["development"])
  }))
  default = {}

  validation {
    condition = alltrue([for id, channel in var.slack_channels :
      can(regex("^[CG][A-Z0-9]+$", id)) &&
      (channel.repo == null ? true : can(regex("^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$", channel.repo))) &&
      (channel.jira_project == null ? true : can(regex("^[A-Z][A-Z0-9_]+$", channel.jira_project))) &&
      alltrue([for component in channel.jira_components : length(component) > 0]) &&
      contains(channel.allowed_workflows, channel.default_workflow) &&
      alltrue([for workflow in channel.allowed_workflows : workflow == "development" || contains(keys(var.workflows), workflow)]) &&
      (!contains(channel.allowed_workflows, "development") || (channel.repo != null && channel.jira_project != null))
    ])
    error_message = "Every channel needs an allowed default and existing workflows; development also needs repo and jira_project."
  }
  validation {
    condition     = length(var.slack_channels) == 0 || contains([for provider in var.decision_providers : provider.name], "jev")
    error_message = "Slack routing requires Jev in decision_providers."
  }
}

variable "routing_confidence" {
  description = "Minimum Jev confidence for selecting a workflow. Below it, ask the requester."
  type        = number
  default     = 0.85
  validation {
    condition     = var.routing_confidence >= 0 && var.routing_confidence <= 1
    error_message = "routing_confidence must be between zero and one."
  }
}

variable "workflows" {
  description = "Workflow definitions. development uses plan/build/check and draft_pr delivery; other workflows use agent/command/approval and report delivery. Omitted development uses the shipped JSON definition."
  type = map(object({
    description          = string
    runner_image         = optional(string)
    questions            = optional(object({ timeout_seconds = optional(number, 259200), max = optional(number, 3) }), {})
    fixes                = optional(object({ rounds = optional(number, 2), attempts = optional(number, 2) }), {})
    repairs              = optional(object({ rounds = optional(number, 3) }), {})
    total_build_attempts = optional(number)
    steps = list(object({
      name            = string
      kind            = string
      inputs          = optional(list(string), [])
      instructions    = optional(string)
      command         = optional(list(string), [])
      output_schema   = optional(string, "{\"type\":\"object\"}")
      model           = optional(string)
      tools           = optional(list(string), ["read", "bash", "edit", "write", "grep", "find", "ls"])
      extensions      = optional(list(string), [])
      environment     = optional(map(string), {})
      secrets         = optional(map(string), {})
      timeout_seconds = optional(number, 7200)
      retries         = optional(number, 0)
      attempts        = optional(number, 1)
      allowed_domains = optional(list(string), [])
      capacity        = optional(string, "on_demand")
      spot_retries    = optional(number, 4)
    }))
    delivery = object({ kind = optional(string, "report"), step = string })
  }))
  default = {}

  validation {
    condition = alltrue([for name, workflow in var.workflows :
      can(regex("^[a-z][a-z0-9_-]{0,39}$", name)) &&
      length(trimspace(workflow.description)) > 0 && length(workflow.description) <= 2000 && length(workflow.steps) > 0 && length(workflow.steps) <= 30 &&
      (workflow.runner_image == null ? true : can(regex("@sha256:[0-9a-f]{64}$", workflow.runner_image))) &&
      length(distinct([for step in workflow.steps : step.name])) == length(workflow.steps) &&
      (name == "development" ? (
        join(",", [for step in workflow.steps : step.kind]) == "plan,build,check" &&
        workflow.delivery.kind == "draft_pr" && try(workflow.delivery.step == workflow.steps[2].name, false) &&
        alltrue([for step in workflow.steps : length(step.inputs) == 0 && length(step.environment) == 0 && length(step.secrets) == 0 && step.retries == 0]) &&
        try(workflow.steps[2].attempts == 1, false)
      ) : workflow.delivery.kind == "report" && contains([for step in workflow.steps : step.name], workflow.delivery.step)) &&
      workflow.questions.timeout_seconds >= 1 && workflow.questions.timeout_seconds <= 31536000 && workflow.questions.timeout_seconds == floor(workflow.questions.timeout_seconds) &&
      workflow.questions.max >= 0 && workflow.questions.max <= 8 && workflow.questions.max == floor(workflow.questions.max) &&
      workflow.fixes.rounds >= 0 && workflow.fixes.rounds <= 8 && workflow.fixes.rounds == floor(workflow.fixes.rounds) &&
      workflow.fixes.attempts >= 1 && workflow.fixes.attempts <= 8 && workflow.fixes.attempts == floor(workflow.fixes.attempts) &&
      workflow.repairs.rounds >= 0 && workflow.repairs.rounds <= 8 && workflow.repairs.rounds == floor(workflow.repairs.rounds) &&
      (workflow.total_build_attempts == null ? true : workflow.total_build_attempts >= 1 && workflow.total_build_attempts <= 128 && workflow.total_build_attempts == floor(workflow.total_build_attempts)) &&
      alltrue([for index, step in workflow.steps :
        (name != "development" || !contains(["start", "route", "decide", "ask", "resume", "handover", "handoverfailed", "done"], step.name)) &&
        can(regex("^[a-z][a-z0-9_-]{0,39}$", step.name)) && contains(name == "development" ? ["plan", "build", "check"] : ["agent", "command", "approval"], step.kind) &&
        (step.kind == "command" ? length(step.command) > 0 : try(length(trimspace(step.instructions)) > 0 && length(base64encode(step.instructions)) <= 32768, false)) &&
        can(keys(jsondecode(step.output_schema))) &&
        (step.model == null ? true : length(step.model) > 0) &&
        alltrue([for tool in step.tools : can(regex("^[a-z][a-z0-9_]*$", tool))]) &&
        alltrue([for extension in step.extensions : startswith(extension, "/")]) &&
        (step.kind == "approval" ? step.timeout_seconds >= 1 && step.timeout_seconds <= 31536000 : step.timeout_seconds > 300 && step.timeout_seconds <= 86400) && step.timeout_seconds == floor(step.timeout_seconds) &&
        contains(["spot", "on_demand"], step.capacity) &&
        step.spot_retries >= 0 && step.spot_retries <= 8 && step.spot_retries == floor(step.spot_retries) &&
        step.attempts >= 1 && step.attempts <= 8 && step.attempts == floor(step.attempts) && (name == "development" || step.attempts == 1) &&
        alltrue([for host in step.allowed_domains : length(host) <= 253 && can(regex("^(\\*\\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$", host))]) &&
        step.retries >= 0 && step.retries <= 3 && step.retries == floor(step.retries) &&
        alltrue([for input in step.inputs : contains([for previous in slice(workflow.steps, 0, index) : previous.name], input)]) &&
        alltrue([for key in concat(keys(step.environment), keys(step.secrets)) :
          can(regex("^[A-Z][A-Z0-9_]*$", key)) && !can(regex("^(AWS_|MORK_|PI_|NODE_|BUN_)", key)) && !contains(["HOME", "PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"], key)
        ]) && alltrue([for arn in values(step.secrets) : can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:.+$", arn))])
      ])
    ])
    error_message = "Workflow definitions need unique steps, valid domains/schemas/environment, bounded retries/timeouts and matching delivery. development requires Plan, Build, Check in order and draft_pr delivery."
  }
}

variable "jira_base_url" {
  description = "Jira Cloud site for Slack tasks, e.g. https://example.atlassian.net."
  type        = string
  default     = ""
}

variable "jira_email" {
  description = "Account the Jira API token belongs to (a service account)."
  type        = string
  default     = ""
}

variable "egress_enforce" {
  description = "Block requests outside the egress allowlist instead of only logging them. The agent can still bypass the proxy (no iptables on Fargate); this stops honest tools from wandering."
  type        = bool
  default     = false
}

variable "otlp_endpoint" {
  description = "OTLP/HTTP endpoint for the agents' live log (e.g. Grafana Alloy or an OpenTelemetry collector). Null: no live log."
  type        = string
  default     = null
}

variable "otlp_cidr_block" {
  description = "CIDR the OTLP endpoint is in, when it is reached on port 4318 inside your network."
  type        = string
  default     = null
}

variable "log_destination" {
  description = "Where Lambdas, phase containers and Step Functions log: cloudwatch (log groups, the default) or otlp (to otlp_endpoint only; no log groups). Lambdas join the VPC when otlp_cidr_block puts the collector inside your network."
  type        = string
  default     = "cloudwatch"
  validation {
    condition     = contains(["cloudwatch", "otlp"], var.log_destination)
    error_message = "log_destination must be cloudwatch or otlp."
  }
  validation {
    condition     = var.log_destination == "cloudwatch" || var.otlp_endpoint != null
    error_message = "log_destination otlp needs otlp_endpoint."
  }
}

variable "otel_resource_attributes" {
  description = "Extra resource attributes on the live log, OTEL_RESOURCE_ATTRIBUTES format: key=value,key=value."
  type        = string
  default     = ""
}

variable "grafana_url" {
  description = "Grafana that shows the live log (Loki); linked from the Slack thread and the PR. Null: no link."
  type        = string
  default     = null
}

variable "grafana_loki_uid" {
  description = "Uid of the Loki data source in grafana_url."
  type        = string
  default     = "loki"
}

variable "bucket_expiration_days" {
  description = "Days task outputs and agent sessions are kept in the bucket."
  type        = number
  default     = 120

  validation {
    condition     = var.bucket_expiration_days >= 1 && var.bucket_expiration_days == floor(var.bucket_expiration_days)
    error_message = "bucket_expiration_days must be a positive whole number."
  }
}

variable "force_destroy" {
  description = "Let terraform destroy the bucket with its objects and the timeline table. Keep false outside sandboxes."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra tags on supported resources, merged with Service=mork and Environment."
  type        = map(string)
  default     = {}
}

variable "alarm_actions" {
  description = "SNS topic ARNs notified by Slack and workflow failure alarms. Empty creates no alarms and no queue for failed Slack invocations."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for arn in var.alarm_actions : can(regex("^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:.+$", arn))])
    error_message = "alarm_actions must contain SNS topic ARNs."
  }
}
