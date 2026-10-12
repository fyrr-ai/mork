# Task sources besides the GitHub label: Slack @mentions, with Jira as the
# tracker. The `slack` function receives the Events API on a Function URL and
# starts the workflow; Start (steps) resolves or creates the Jira issue and
# reports progress into the Slack thread. Secrets are created out of band and
# referenced by name, so this file applies before they exist.


locals {
  source_secret_arns = { for k, name in local.source_secret_names : k => "arn:aws:secretsmanager:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:secret:${name}-*" }
}

resource "aws_cloudwatch_log_group" "slack" {
  name              = "/aws/lambda/${local.name}_slack"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "slack" {
  name               = "${local.name}_slack"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "slack_logs" {
  role       = aws_iam_role.slack.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "slack" {
  statement {
    sid       = "StartTasks"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.this.arn]
  }
  statement {
    sid       = "ReadSlackSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.source_secret_arns.slack_signing_secret, local.source_secret_arns.slack_bot_token, local.source_secret_arns.jira_api_token]
  }
  # A mention in a task's thread: the thread → run link, a parked question,
  # the answer recorded with the task, and the run's state for status.
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
    sid       = "AnswerQuestions"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mork.arn}/threads/*", "${aws_s3_bucket.mork.arn}/tasks/*/answers.json"]
  }
  statement {
    sid       = "ReportStatus"
    actions   = ["states:DescribeExecution", "states:GetExecutionHistory"]
    resources = ["arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:execution:${aws_sfn_state_machine.this.name}:*"]
  }
  statement {
    # Task-token APIs have no resource type; the token is the authorization.
    sid       = "ResumeRuns"
    actions   = ["states:SendTaskSuccess"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "slack" {
  name   = "slack"
  role   = aws_iam_role.slack.id
  policy = data.aws_iam_policy_document.slack.json
}

data "aws_iam_policy_document" "steps_sources" {
  statement {
    sid       = "ReadSourceSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.source_secret_arns.slack_bot_token, local.source_secret_arns.jira_api_token]
  }
  statement {
    sid       = "ParkQuestions"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.mork.arn}/threads/*"]
  }
}

resource "aws_iam_role_policy" "steps_sources" {
  name   = "sources"
  role   = aws_iam_role.lambda["steps"].id
  policy = data.aws_iam_policy_document.steps_sources.json
}

resource "aws_lambda_function" "slack" {
  function_name = "${local.name}_slack"
  role          = aws_iam_role.slack.arn
  package_type  = "Image"
  image_uri     = local.lambda_image
  architectures = ["x86_64"]
  timeout       = 10
  memory_size   = 512

  image_config {
    command = ["packages/sources/lambda-slack.handler"]
  }

  environment {
    variables = {
      STATE_MACHINE_ARN              = aws_sfn_state_machine.this.arn
      MORK_BUCKET                    = aws_s3_bucket.mork.bucket
      SLACK_CHANNELS                 = jsonencode(var.slack_channels)
      SLACK_SIGNING_SECRET_SECRET_ID = local.source_secret_names.slack_signing_secret
      SLACK_BOT_TOKEN_SECRET_ID      = local.source_secret_names.slack_bot_token
      JIRA_API_TOKEN_SECRET_ID       = local.source_secret_names.jira_api_token
      JIRA_BASE_URL                  = var.jira_base_url
      JIRA_EMAIL                     = var.jira_email
    }
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_cloudwatch_log_group.slack]
}

# Public by design: Slack cannot sign AWS requests. The function checks the
# Slack signature and timestamp before it does anything.
resource "aws_lambda_function_url" "slack" {
  function_name      = aws_lambda_function.slack.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "slack_url" {
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.slack.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
