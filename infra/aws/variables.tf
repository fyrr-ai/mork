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
}

variable "vpc_private_subnet_ids" {
  description = "Private subnets for the phase tasks."
  type        = list(string)
}

variable "repo_allowlist" {
  description = "owner/repo names Mork may work on; every other repository is ignored at intake."
  type        = list(string)
}

variable "llm_base_url" {
  description = "Base URL of an OpenAI-compatible chat completions API, e.g. https://api.example.com/v1. Its key is the secret <secret_prefix>/llm-api-key."
  type        = string
}

variable "model" {
  description = "Model id passed to that API for planning, coding and review."
  type        = string
}

variable "secret_prefix" {
  description = "Secrets Manager names are <secret_prefix>/<name> (llm-api-key, github-token, github-read-token, github-push-token, webhook-secret, slack-*, jira-api-token, <provider>-api-key). Create them with scripts/aws-secrets.sh before applying."
  type        = string
  default     = "mork"
}

variable "decision_providers" {
  description = "Decision models to ask (jev, openai); the first decides, the others are recorded for comparison. Empty: no decision model, every PR gets careful review. Each needs the secret <secret_prefix>/<provider>-api-key."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.decision_providers : contains(["jev", "openai"], p)])
    error_message = "decision_providers may only list jev and openai."
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
}

variable "supervise_seconds" {
  description = "How often each phase container asks the decision model whether its LLM station is stuck."
  type        = number
  default     = 45
}

variable "answer_seconds" {
  description = "How long a task waits for the requester to answer a question before it goes to a person."
  type        = number
  default     = 259200
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

variable "bucket_expiration_days" {
  description = "Days task outputs and agent sessions are kept in the bucket."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "Let terraform destroy the bucket with its objects and the timeline table. Keep false outside sandboxes."
  type        = bool
  default     = false
}
