# Minimal deployment. Create the secrets first (scripts/aws-secrets.sh), then
# terraform apply, then push the images (scripts/deploy.sh).

provider "aws" {
  region = "eu-west-1"
}

module "mork" {
  source = "../.."

  vpc_id                 = "vpc-0123456789abcdef0"
  vpc_cidr_block         = "10.0.0.0/16"
  vpc_private_subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]

  repo_allowlist = ["acme/widgets"]

  # Any OpenAI-compatible API; its key is the secret mork/llm-api-key.
  llm_base_url = "https://api.example.com/v1"
  model        = "your-model-id"

  # Optional: a decision model for triage and the review recommendation.
  # decision_providers = ["jev"]

  # Optional: Slack as a task source, with Jira as the tracker.
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
