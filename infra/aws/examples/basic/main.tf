# Minimal deployment. Create the secrets first (scripts/aws-secrets.sh), then
# mise run infra:bootstrap, mise run images:push, then mise run infra:apply.

provider "aws" {
  # Set AWS_REGION through mise.local.toml.
  default_tags {
    tags = { Service = "mork" }
  }
}

variable "image_digests" {
  type    = map(string)
  default = {}
}

module "mork" {
  image_digests = var.image_digests
  source        = "../.."

  vpc_id                 = "vpc-0123456789abcdef0"
  vpc_cidr_block         = "10.0.0.0/16"
  vpc_private_subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]

  repo_allowlist = ["acme/widgets"]
  # Optional: mork/github-app holds the App installation ID, App ID and private key.
  # github_auth_mode = "app"

  # Any OpenAI-compatible API; its key is the secret mork/llm-api-key.
  llm_base_url = "https://api.example.com/v1"
  model        = "your-model-id"

  # The same JSON also drives the trusted local development runner.
  # Copy it into your deployment to customize prompts, domains and retry budgets.
  workflows = {
    development = jsondecode(file("${path.module}/../../../../packages/contracts/src/development.json"))
  }

  # Optional: a decision model for triage and the review recommendation.
  # decision_providers = [{ name = "jev" }]

  # Optional: Slack as a task source. Jev is required for Slack routing.
  # For configured workflows without a repository, see docs/workflows.md.
  # slack_channels = { C0123456789 = { repo = "acme/widgets", jira_project = "PROJ" } }
  # jira_base_url  = "https://example.atlassian.net"
  # jira_email     = "mork-bot@example.com"

  # Optional: the agents' live log.
  # otlp_endpoint = "http://otel-collector.internal:4318"
  # grafana_url   = "https://grafana.example.com"
}

output "webhook_url" {
  value = module.mork.webhook_url
}

output "slack_events_url" {
  value = module.mork.slack_events_url
}
