# Functions from one container image: `steps` runs everything between
# phases, `intake` receives GitHub webhooks on a Function URL (`slack` is in sources.tf).

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  tags              = local.tags
  for_each          = toset(["steps", "intake"])
  name              = "/aws/lambda/${local.name}_${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "lambda" {
  tags               = local.tags
  for_each           = toset(["steps", "intake"])
  name               = "${local.name}_${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  for_each   = toset(["steps", "intake"])
  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "steps" {
  statement {
    sid       = "WriteWorkflowArtifacts"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mork.arn}/tasks/workflows/*/steps/*", "${aws_s3_bucket.mork.arn}/tasks/workflows/*/run.json", "${aws_s3_bucket.mork.arn}/tasks/workflows/*/status.json"]
  }
  statement {
    sid       = "ReadTaskOutputs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.mork.arn}/tasks/*"]
  }
  statement {
    sid       = "HiddenTestsStayHidden"
    effect    = "Deny"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.mork.arn}/tasks/*/hidden/*"]
  }
  statement {
    # Without ListBucket, S3 answers a missing key with 403 instead of 404, and
    # "no answers yet" or "no parked question" would look like an access error.
    sid       = "SeeMissingKeys"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.mork.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["tasks/*", "threads/*"]
    }
  }
  statement {
    sid       = "WriteIssue"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mork.arn}/tasks/*/issue.json"]
  }
  statement {
    # Fix runs after the PR: the feedback for Build and the PR record that lets them continue the task.
    sid       = "WriteFixRuns"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.mork.arn}/tasks/*/pr.json", "${aws_s3_bucket.mork.arn}/tasks/*/build/*/feedback.md"]
  }
  statement {
    # A fix run's claim on its PR expires with its execution.
    sid       = "SeeFixRuns"
    actions   = ["states:DescribeExecution"]
    resources = ["${replace(aws_sfn_state_machine.this.arn, ":stateMachine:", ":execution:")}:*"]
  }
  statement {
    sid       = "StopStationsOnHandover"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid     = "ReadStepSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [data.aws_secretsmanager_secret.this["github_token"].arn, data.aws_secretsmanager_secret.this["llm_api_key"].arn],
      [for s in data.aws_secretsmanager_secret.decision : s.arn],
    )
  }
  statement {
    sid       = "WriteTimeline"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.timeline.arn]
  }
}

resource "aws_iam_role_policy" "steps" {
  name   = "steps"
  role   = aws_iam_role.lambda["steps"].id
  policy = data.aws_iam_policy_document.steps.json
}

data "aws_iam_policy_document" "intake" {
  statement {
    sid     = "ReadIntakeSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      data.aws_secretsmanager_secret.this["webhook_secret"].arn,
      data.aws_secretsmanager_secret.this["github_token"].arn,
    ]
  }
  statement {
    sid       = "StartTask"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.this.arn]
  }
  statement {
    sid       = "RecordPrOutcomes"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.timeline.arn]
  }
}

resource "aws_iam_role_policy" "intake" {
  name   = "intake"
  role   = aws_iam_role.lambda["intake"].id
  policy = data.aws_iam_policy_document.intake.json
}

locals {
  lambda_image = "${aws_ecr_repository.this["lambda"].repository_url}@${lookup(var.image_digests, "lambda", "sha256:missing")}"
}

resource "aws_lambda_function" "steps" {
  publish       = true
  tags          = local.tags
  function_name = "${local.name}_steps"
  role          = aws_iam_role.lambda["steps"].arn
  package_type  = "Image"
  image_uri     = local.lambda_image
  architectures = ["x86_64"]
  timeout       = 600
  memory_size   = 1024

  ephemeral_storage {
    size = 2048
  }

  image_config {
    command = ["packages/steps/lambda-steps.handler"]
  }

  environment {
    variables = merge({
      MORK_BUCKET               = aws_s3_bucket.mork.bucket
      MORK_TIMELINE_TABLE       = aws_dynamodb_table.timeline.name
      SLACK_BOT_TOKEN_SECRET_ID = local.source_secret_names.slack_bot_token
      JIRA_API_TOKEN_SECRET_ID  = local.source_secret_names.jira_api_token
      JIRA_BASE_URL             = var.jira_base_url
      JIRA_EMAIL                = var.jira_email
      MORK_MODEL                = var.model
      LLM_BASE_URL              = var.llm_base_url
      ECS_CLUSTER               = aws_ecs_cluster.this.name
      GITHUB_TOKEN_SECRET_ID    = data.aws_secretsmanager_secret.this["github_token"].arn
      LLM_API_KEY_SECRET_ID     = data.aws_secretsmanager_secret.this["llm_api_key"].arn
      }, var.grafana_url == null ? {} : { MORK_GRAFANA_URL = var.grafana_url, MORK_GRAFANA_LOKI_UID = var.grafana_loki_uid },
      local.decision_settings,
    { for p, s in data.aws_secretsmanager_secret.decision : "${local.decision_env[p]}_SECRET_ID" => s.arn })
  }

  # Terraform deploys the uploaded digest and publishes a version for workflows.
  lifecycle {
    precondition {
      condition     = length(var.image_digests) == 3
      error_message = "Upload images and supply all three image_digests before a full apply."
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function" "intake" {
  tags          = local.tags
  function_name = "${local.name}_intake"
  role          = aws_iam_role.lambda["intake"].arn
  package_type  = "Image"
  image_uri     = local.lambda_image
  architectures = ["x86_64"]
  timeout       = 30
  memory_size   = 512

  image_config {
    command = ["packages/steps/lambda-intake.handler"]
  }

  environment {
    variables = {
      STATE_MACHINE_ARN        = aws_sfn_state_machine.this.arn
      MORK_TIMELINE_TABLE      = aws_dynamodb_table.timeline.name
      REPO_ALLOWLIST           = join(",", var.repo_allowlist)
      GITHUB_TOKEN_SECRET_ID   = data.aws_secretsmanager_secret.this["github_token"].arn
      WEBHOOK_SECRET_SECRET_ID = data.aws_secretsmanager_secret.this["webhook_secret"].arn
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.image_digests) == 3
      error_message = "Upload images and supply all three image_digests before a full apply."
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# Public by design: GitHub cannot sign AWS requests. The function checks the
# webhook HMAC before it does anything.
resource "aws_lambda_function_url" "intake" {
  function_name      = aws_lambda_function.intake.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "intake_url" {
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.intake.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Function URL requests need both permissions. This does not expose Invoke directly.
resource "aws_lambda_permission" "intake_url_invoke" {
  statement_id             = "PublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.intake.function_name
  principal                = "*"
  invoked_via_function_url = true
}
