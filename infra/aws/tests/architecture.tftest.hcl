# Plans only. All AWS resources and account lookups use an in-process mock.
mock_provider "aws" {
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/mork-execution-status" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:function:mork-steps", qualified_arn = "arn:aws:lambda:us-east-1:123456789012:function:mork-steps:1" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:mork-slack-failures" }
  }
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
  image_digests          = { runner = "sha256:0000000000000000000000000000000000000000000000000000000000000000", egress = "sha256:1111111111111111111111111111111111111111111111111111111111111111", lambda = "sha256:2222222222222222222222222222222222222222222222222222222222222222" }
  vpc_id                 = "vpc-0123456789abcdef0"
  vpc_cidr_block         = "10.0.0.0/16"
  vpc_private_subnet_ids = ["subnet-0123456789abcdef0"]
  repo_allowlist         = ["acme/widgets"]
  llm_base_url           = "https://api.example.com/v1"
  model                  = "example-model"
}

run "native_arm_workers_and_x86_lambda" {
  command = plan
  variables {
    workflows = { analysis = {
      description = "Architecture fixture"
      steps       = [{ name = "analyze", kind = "agent", instructions = "Analyze" }]
      delivery    = { step = "analyze" }
    } }
  }
  assert {
    condition     = alltrue([for task in aws_ecs_task_definition.phase : one(task.runtime_platform).cpu_architecture == "ARM64"])
    error_message = "Every development phase must execute the ARM64 runner and egress."
  }
  assert {
    condition     = length(aws_ecs_task_definition.workflow_step) > 0 && alltrue([for task in aws_ecs_task_definition.workflow_step : one(task.runtime_platform).cpu_architecture == "ARM64"])
    error_message = "Configured workflow tasks must execute the same ARM64 runtime."
  }
  assert {
    condition     = alltrue([for fn in [aws_lambda_function.steps, aws_lambda_function.intake, aws_lambda_function.slack] : one(fn.architectures) == "x86_64"])
    error_message = "Lambda remains x86_64; ARM worker migration must not change its ABI."
  }
}
