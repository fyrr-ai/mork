# Mork: a GitHub issue or Slack request → a verified draft PR.
#
#   webhook → intake Lambda (Function URL) → Step Functions → Plan, Build, Check
#
# Step Functions owns the order, retries and timeouts and runs one Fargate
# container per phase (runTask.waitForTaskToken). Containers read the outputs
# they need from the factory bucket, write their own, and report back with
# the task token; the execution only carries a small brief. The steps Lambda
# holds the GitHub write token and the decision model: start, decide, ask,
# handover and fix runs.

data "aws_region" "current" {}

locals {
  name = var.name
  # Hyphenated variant for resources whose names reject underscores.
  dash = replace(var.name, "_", "-")

  # Secrets are created out of band (scripts/aws-secrets.sh); Terraform only references them.
  secret_names = {
    llm_api_key       = "${var.secret_prefix}/llm-api-key"
    github_token      = "${var.secret_prefix}/github-token"
    github_read_token = "${var.secret_prefix}/github-read-token"
    github_push_token = "${var.secret_prefix}/github-push-token"
    webhook_secret    = "${var.secret_prefix}/webhook-secret"
  }
  source_secret_names = {
    slack_signing_secret = "${var.secret_prefix}/slack-signing-secret"
    slack_bot_token      = "${var.secret_prefix}/slack-bot-token"
    jira_api_token       = "${var.secret_prefix}/jira-api-token"
  }
}

data "aws_secretsmanager_secret" "this" {
  for_each = local.secret_names
  name     = each.value
}

# Decision API keys go only to the steps Lambda and the Build container.
locals {
  decision_env = { jev = "JEV_API", openai = "OPENAI_API_KEY" }
}

data "aws_secretsmanager_secret" "decision" {
  for_each = toset(var.decision_providers)
  name     = "${var.secret_prefix}/${each.key}-api-key"
}

# Deploys move the `current` tag; commit tags are never overwritten. Phase
# containers resolve `current` at launch, so a deploy needs no Terraform run.
# trivy:ignore:AWS-0031
resource "aws_ecr_repository" "this" {
  for_each             = toset(["runner", "egress", "lambda"])
  name                 = "${local.dash}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# Phases run on Fargate Spot. A reclaimed container gets SIGTERM two minutes
# ahead (stopTimeout 120 s): the runner saves its session and pushes the
# implementer's work, then fails the phase as Mork.Interrupted and Step
# Functions retries it.
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}
