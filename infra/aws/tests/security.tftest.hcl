# Plans only. All AWS resources and account lookups use an in-process mock.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1", name = "us-east-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/mork" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mork" }
  }
  mock_resource "aws_sfn_state_machine" {
    defaults = { arn = "arn:aws:states:us-east-1:123456789012:stateMachine:mork" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mork-test" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/mork" }
  }
}

variables {
  vpc_id                 = "vpc-0123456789abcdef0"
  vpc_cidr_block         = "10.0.0.0/16"
  vpc_private_subnet_ids = ["subnet-0123456789abcdef0"]
  repo_allowlist         = ["acme/widgets"]
  llm_base_url           = "https://api.example.com/v1"
  model                  = "example-model"
}

run "webhook_permissions_and_timeout" {
  command = plan
  variables {
    phase_seconds = { plan = 1000, build = 2000, check = 3000 }
  }
  assert {
    condition     = aws_lambda_permission.intake_url.action == "lambda:InvokeFunctionUrl" && aws_lambda_permission.intake_url_invoke.action == "lambda:InvokeFunction" && aws_lambda_permission.intake_url_invoke.invoked_via_function_url
    error_message = "GitHub URL must allow both URL invocation and invocation restricted to URLs."
  }
  assert {
    condition     = aws_lambda_permission.slack_url.action == "lambda:InvokeFunctionUrl" && aws_lambda_permission.slack_url_invoke.action == "lambda:InvokeFunction" && aws_lambda_permission.slack_url_invoke.invoked_via_function_url
    error_message = "Slack URL must allow both URL invocation and invocation restricted to URLs."
  }
  assert {
    condition     = local.definition.States.Plan.TimeoutSeconds == 1000 && local.definition.States.Build.TimeoutSeconds == 2000 && local.definition.States.Check.TimeoutSeconds == 3000 && local.definition.TimeoutSeconds > var.answer_seconds * 3 + 1000 + 3 * (2000 + 3000)
    error_message = "Workflow budget must use configured phase timeouts and include retries and questions."
  }
  assert {
    condition     = local.definition.States.Handover.Catch[0].Next == "HandoverFailed" && local.definition.States.HandoverFailed.Type == "Fail"
    error_message = "An exhausted handover retry must remain a visible failure."
  }
  assert {
    condition     = length([for statement in data.aws_iam_policy_document.phase["build"].statement : statement if statement.sid == "HiddenTestsStayHidden" && statement.effect == "Deny" && contains(statement.actions, "s3:GetObject") && contains(statement.resources, "${aws_s3_bucket.mork.arn}/tasks/*/hidden/*")]) == 1
    error_message = "Build must explicitly deny hidden test reads even if another policy later grants them."
  }
  assert {
    condition     = aws_ecr_repository.this["runner"].force_delete == false
    error_message = "Production image repositories must not be deleted with their contents."
  }
}

run "reject_fractional_timeout" {
  command = plan
  variables { phase_seconds = { plan = 0.5, build = 1000, check = 1000 } }
  expect_failures = [var.phase_seconds]
}

run "reject_repository_url" {
  command = plan
  variables { repo_allowlist = ["https://github.com/acme/widgets"] }
  expect_failures = [var.repo_allowlist]
}

run "reject_unsupported_fargate_size" {
  command = plan
  variables { station_size = { cpu = 256, memory = 8192 } }
  expect_failures = [var.station_size]
}

run "reject_timeout_at_heartbeat" {
  command = plan
  variables { phase_seconds = { plan = 300, build = 1000, check = 1000 } }
  expect_failures = [var.phase_seconds]
}
