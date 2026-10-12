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
  description = "CloudWatch log retention in days."
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
  description = "Secrets Manager names are <secret_prefix>/<name> (llm-api-key, github-token, github-read-token, github-push-token, webhook-secret, slack-*, jira-api-token, <provider>-api-key). Create them with scripts/aws-secrets.sh before applying."
  type        = string
  default     = "mork"
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

variable "image_tag" {
  description = "Mutable tag the images are deployed under; scripts/deploy.sh moves it."
  type        = string
  default     = "current"
}

variable "phase_seconds" {
  description = "Seconds a phase container may run before Step Functions gives up on it."
  type        = object({ plan = number, build = number, check = number })
  # No turn or time limits run inside the containers; this only catches hangs.
  default = { plan = 7200, build = 7200, check = 7200 }

  validation {
    condition     = alltrue([for seconds in values(var.phase_seconds) : seconds > 300 && seconds <= 31536000 && seconds == floor(seconds)])
    error_message = "Phase timeouts must be whole seconds greater than the 300-second heartbeat, at most one year."
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

variable "spot_attempts" {
  description = "Retries of a phase on Fargate Spot after an interruption or a capacity shortage before it moves to on-demand Fargate."
  type        = number
  default     = 4

  validation {
    condition     = var.spot_attempts >= 0 && var.spot_attempts <= 8 && var.spot_attempts == floor(var.spot_attempts)
    error_message = "spot_attempts must be a whole number between 0 and 8."
  }
}

variable "supervise_seconds" {
  description = "How often each phase container asks the decision model whether its LLM station is stuck."
  type        = number
  default     = 45

  validation {
    condition     = var.supervise_seconds >= 1 && var.supervise_seconds == floor(var.supervise_seconds)
    error_message = "supervise_seconds must be positive whole seconds."
  }
}

variable "answer_seconds" {
  description = "How long a task waits for the requester to answer a question before it goes to a person."
  type        = number
  default     = 259200

  validation {
    condition     = var.answer_seconds >= 1 && var.answer_seconds <= 31536000 && var.answer_seconds == floor(var.answer_seconds)
    error_message = "answer_seconds must be positive whole seconds, at most one year."
  }
}

variable "slack_channels" {
  description = "Slack channel ID → repository (and Jira project) its @mork mentions work on. Empty: no Slack source."
  type        = map(object({ repo = string, jira_project = string, jira_components = optional(list(string), []) }))
  default     = {}
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

variable "egress_allow" {
  description = "Extra hosts for the egress sidecar's allowlist (package registries, artifact stores), besides the LLM host, GitHub, npm and PyPI."
  type        = list(string)
  default     = []
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
  default     = 90

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
