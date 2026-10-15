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

run "webhook_permissions_and_timeout" {
  command = plan
  variables {
    workflows = { development = {
      description = "Configured development"
      steps = [
        { name = "design", kind = "plan", instructions = "Plan", attempts = 2, timeout_seconds = 1000, capacity = "spot", spot_retries = 2, allowed_domains = ["github.com"] },
        { name = "implement", kind = "build", instructions = "Build", attempts = 3, timeout_seconds = 2000, capacity = "spot", spot_retries = 1, allowed_domains = ["github.com", "registry.npmjs.org"] },
        { name = "verify", kind = "check", instructions = "Check", timeout_seconds = 3000, allowed_domains = ["github.com"] }
      ]
      delivery = { kind = "draft_pr", step = "verify" }
    } }
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
    condition     = local.definition.States.Design.TimeoutSeconds == 1000 && local.definition.States.Implement.TimeoutSeconds == 2000 && local.definition.States.Verify.TimeoutSeconds == 3000 && local.definition.TimeoutSeconds > local.development.questions.timeout_seconds * local.development.questions.max + 1000 + 3 * (2000 + 3000)
    error_message = "Workflow budget must use configured phase timeouts and include retries and questions."
  }
  assert {
    condition     = local.definition.States.Handover.Catch[0].Next == "HandoverFailed" && local.definition.States.HandoverFailed.Type == "Fail"
    error_message = "An exhausted handover retry must remain a visible failure."
  }
  assert {
    condition     = contains([for statement in data.aws_iam_policy_document.steps.statement : statement.resources if statement.sid == "WriteWorkflowArtifacts"][0], "${aws_s3_bucket.mork.arn}/tasks/workflows/*/status.json")
    error_message = "Failure artifacts must be writable by the steps Lambda."
  }
  assert {
    condition = alltrue([for phase in ["plan", "build", "check"] :
      contains(one([for statement in data.aws_iam_policy_document.phase[phase].statement : statement.resources if statement.sid == "ReadInputs"]), "${aws_s3_bucket.mork.arn}/tasks/*/check/*") == (phase == "check")
    ])
    error_message = "Only Check may read cached OCR and previous review results for resumed verification and repair rounds."
  }
  assert {
    condition     = length([for statement in data.aws_iam_policy_document.phase["build"].statement : statement if statement.sid == "HiddenTestsStayHidden" && statement.effect == "Deny" && contains(statement.actions, "s3:GetObject") && contains(statement.resources, "${aws_s3_bucket.mork.arn}/tasks/*/hidden/*")]) == 1
    error_message = "Build must explicitly deny hidden test reads even if another policy later grants them."
  }
  assert {
    condition     = local.definition.States.Design.Parameters.CapacityProviderStrategy[0].CapacityProvider == "FARGATE_SPOT" && local.definition.States.DesignOnDemand.Parameters.CapacityProviderStrategy[0].CapacityProvider == "FARGATE" && local.definition.States.Implement.Retry[0].MaxAttempts == 1 && local.definition.States.Verify.Parameters.CapacityProviderStrategy[0].CapacityProvider == "FARGATE" && !contains(keys(local.definition.States), "VerifyOnDemand")
    error_message = "Capacity and Spot retry/fallback must be isolated per configured step."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.phase["plan"].container_definitions)[1].environment[1].value == "github.com" && jsondecode(aws_ecs_task_definition.phase["build"].container_definitions)[1].environment[1].value == "github.com,registry.npmjs.org" && jsondecode(jsondecode(aws_ecs_task_definition.phase["plan"].container_definitions)[0].environment[1].value).instructions == "Plan" && local.definition.States.Start.Parameters.Payload.policy.build_attempts == 3 && local.definition.States.Start.Parameters.Payload.policy.repairs.rounds == 3
    error_message = "Runner instructions, allowed domains and retry policy must come from the same workflow definition."
  }
  assert {
    condition     = aws_ecs_task_definition.phase["plan"].skip_destroy && aws_lambda_function.steps.publish && local.definition.States.Start.Parameters.FunctionName == aws_lambda_function.steps.qualified_arn && jsondecode(aws_ecs_task_definition.phase["plan"].container_definitions)[0].image == "${aws_ecr_repository.this["runner"].repository_url}@${var.image_digests.runner}"
    error_message = "Development must retain pinned task revisions, publish steps Lambda and use image digests."
  }
  assert {
    condition = alltrue([for phase in ["plan", "build", "check"] :
      one([for secret in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[0].secrets : secret.valueFrom if secret.name == "GITHUB_TOKEN"]) == data.aws_secretsmanager_secret.this["github_token"].arn &&
      (phase == "build" ? one([for secret in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[1].secrets : secret.valueFrom if secret.name == "GITHUB_TOKEN"]) == data.aws_secretsmanager_secret.this["github_token"].arn : alltrue([for secret in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[1].secrets : secret.name != "GITHUB_TOKEN"]))
    ]) && aws_lambda_function.steps.environment[0].variables.GITHUB_TOKEN_SECRET_ID == data.aws_secretsmanager_secret.this["github_token"].arn
    error_message = "Development uses one GitHub credential; only Build's proxy may authenticate the agent's Git requests."
  }
  assert {
    condition     = aws_ecr_repository.this["runner"].force_delete == false
    error_message = "Production image repositories must not be deleted with their contents."
  }
  assert {
    condition     = local.definition.States.DesignAsked.Default == "Implement" && local.definition.States.ImplementAsked.Default == "Verify" && local.definition.States.VerifyAsked.Default == "Decide" && local.definition.States.Resume.Choices[2].Next == "Verify" && local.definition.States.Route.Choices[0].Next == "Design" && local.definition.States.Design.Parameters.TaskDefinition == aws_ecs_task_definition.phase["plan"].arn
    error_message = "Configured operation names must drive ordering, question resumption and pinned task definitions."
  }
}


run "github_app_credentials_and_rotating_build_proxy" {
  command = plan
  variables { github_auth_mode = "app" }
  assert {
    condition = alltrue([for phase in ["plan", "build", "check"] :
      one([for secret in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[0].secrets : secret.valueFrom if secret.name == "GITHUB_APP"]) == data.aws_secretsmanager_secret.this["github_app"].arn &&
      alltrue([for secret in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[1].secrets : !contains(["GITHUB_APP", "GITHUB_TOKEN"], secret.name)]) &&
      jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[0].mountPoints[0].readOnly == (phase != "build")
    ]) && !contains(keys(data.aws_secretsmanager_secret.this), "github_token")
    error_message = "Only trusted runners receive the App key; only Build can write the proxy token file."
  }
  assert {
    condition     = aws_lambda_function.steps.environment[0].variables.GITHUB_APP_SECRET_ID == data.aws_secretsmanager_secret.this["github_app"].arn && aws_lambda_function.intake.environment[0].variables.GITHUB_APP_SECRET_ID == data.aws_secretsmanager_secret.this["github_app"].arn && !contains(keys(aws_lambda_function.steps.environment[0].variables), "GITHUB_TOKEN_SECRET_ID")
    error_message = "Both GitHub consumers must use App authentication, with no static-token dependency."
  }
  assert {
    condition = alltrue([for phase in ["plan", "build", "check"] :
      length([for env in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[0].environment : env if env.name == "GITHUB_TOKEN_FILE" && env.value == "/mork-egress/github-token"]) == (phase == "build" ? 1 : 0) &&
      length([for env in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions)[1].environment : env if env.name == "GITHUB_TOKEN_FILE" && env.value == "/mork-egress/github-token"]) == (phase == "build" ? 1 : 0)
    ])
    error_message = "Only Build authenticates the agent's Git requests with a renewable token file."
  }
}

run "reject_fractional_timeout" {
  command = plan
  variables { workflows = { development = {
    description = "Invalid timeout"
    steps = [
      { name = "plan", kind = "plan", instructions = "Plan", timeout_seconds = 0.5 },
      { name = "build", kind = "build", instructions = "Build" },
      { name = "check", kind = "check", instructions = "Check" }
    ]
    delivery = { kind = "draft_pr", step = "check" }
  } } }
  expect_failures = [var.workflows]
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
  variables { workflows = { development = {
    description = "Invalid timeout"
    steps = [
      { name = "plan", kind = "plan", instructions = "Plan", timeout_seconds = 300 },
      { name = "build", kind = "build", instructions = "Build" },
      { name = "check", kind = "check", instructions = "Check" }
    ]
    delivery = { kind = "draft_pr", step = "check" }
  } } }
  expect_failures = [var.workflows]
}

run "configured_workflows" {
  command = plan
  variables {
    decision_providers = [{ name = "jev" }]
    workflows = {
      analysis = {
        description = "Analyze data and deliver a report."
        steps = [
          { name = "analyze", kind = "agent", instructions = "Analyze the request and write a report.", capacity = "spot", spot_retries = 2, allowed_domains = ["warehouse.example.test"] },
          { name = "validate", kind = "command", inputs = ["analyze"], command = ["node", "validate.mjs"] },
          { name = "approve", kind = "approval", timeout_seconds = 259200, inputs = ["analyze", "validate"], instructions = "Approve publication?" },
          { name = "publish", kind = "command", inputs = ["analyze", "approve"], command = ["node", "publish.mjs"] },
        ]
        delivery = { step = "publish" }
      }
      dashboard = {
        description = "Create Grafana dashboards."
        steps       = [{ name = "create", kind = "agent", instructions = "Create the requested dashboard JSON." }]
        delivery    = { step = "create" }
      }
    }
    slack_channels = { CDEMO = { default_workflow = "analysis", allowed_workflows = ["analysis", "dashboard"] } }
  }
  assert {
    condition     = length(aws_sfn_state_machine.workflow) == 2 && length(aws_ecs_task_definition.workflow_step) == 4
    error_message = "Each workflow must have its own state machine; approvals do not launch containers."
  }
  assert {
    condition     = local.workflow_definitions.analysis.States.step_analyze.Parameters.TaskDefinition == aws_ecs_task_definition.workflow_step["analysis.analyze"].arn && local.workflow_definitions.analysis.States.step_analyze.Next == "step_validate"
    error_message = "State machines must use pinned task-definition revisions and configured ordering."
  }
  assert {
    condition     = local.workflow_definitions.analysis.States.step_analyze.Parameters.Overrides.ContainerOverrides[0].Environment[1].Name == "MORK_WORKFLOW_EXECUTION"
    error_message = "ECS overrides must carry only the execution name; large requests are read from S3."
  }
  assert {
    condition     = local.workflow_definitions.analysis.States.step_approve.TimeoutSeconds == 259200 && local.workflow_definitions.analysis.States.approved_approve.Default == "Rejected" && local.workflow_definitions.analysis.States.record_approve.Next == "step_publish" && local.workflow_definitions.analysis.States.Failure.Type == "Fail"
    error_message = "Publishing requires explicit approval; rejection remains a failed execution."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.workflow_step["analysis.analyze"].container_definitions)[0].command[1] == "packages/runner/src/workflow-main.ts" && length(jsondecode(aws_ecs_task_definition.workflow_step["analysis.analyze"].container_definitions)[0].secrets) == 0
    error_message = "Generic steps use the real workflow entrypoint without inherited development secrets."
  }
  assert {
    condition     = local.workflow_definitions.analysis.States.step_analyze.Parameters.CapacityProviderStrategy[0].CapacityProvider == "FARGATE_SPOT" && local.workflow_definitions.analysis.States.fallback_analyze.Parameters.CapacityProviderStrategy[0].CapacityProvider == "FARGATE" && local.workflow_definitions.analysis.States.fallback_analyze.Next == "step_validate" && jsondecode(aws_ecs_task_definition.workflow_step["analysis.analyze"].container_definitions)[1].environment[1].value == "warehouse.example.test" && jsondecode(aws_ecs_task_definition.workflow_step["analysis.validate"].container_definitions)[1].environment[1].value == ""
    error_message = "Generic Spot steps must preserve ordering on fallback and receive only their own domains."
  }
  assert {
    condition     = aws_ecs_task_definition.workflow_step["analysis.analyze"].skip_destroy && jsondecode(aws_iam_role_policy.workflow_sfn["analysis"].policy).Statement[2].Resource[0] == "${aws_ecs_task_definition.workflow_step["analysis.analyze"].arn_without_revision}:*" && local.workflow_definitions.analysis.States.Report.Catch[0].Next == "Failed" && local.workflow_definitions.analysis.States.Failed.Catch[0].Next == "Failure" && local.workflow_definitions.analysis.States.Report.Parameters.FunctionName == aws_lambda_function.steps.qualified_arn
    error_message = "A rollout must retain old revisions and their invocation permissions; terminal notification failures must be caught."
  }
  assert {
    condition     = aws_lambda_function.slack.environment[0].variables.MORK_SLACK_FUNCTION_NAME == "mork_slack" && aws_lambda_function.slack.environment[0].variables.JEV_API_SECRET_ID == data.aws_secretsmanager_secret.decision["jev"].arn
    error_message = "Slack must enqueue its worker and use Jev for routing."
  }
}

run "reject_forward_workflow_input" {
  command = plan
  variables {
    workflows = {
      analysis = {
        description = "Analysis"
        steps       = [{ name = "analyze", kind = "agent", inputs = ["missing"], instructions = "Analyze" }]
        delivery    = { step = "analyze" }
      }
    }
  }
  expect_failures = [var.workflows]
}

run "reject_slack_without_jev" {
  command = plan
  variables { slack_channels = { CDEMO = { repo = "acme/widgets", jira_project = "DEMO" } } }
  expect_failures = [var.slack_channels]
}

run "reject_domain_injection" {
  command = plan
  variables {
    workflows = { analysis = {
      description = "Analysis"
      steps       = [{ name = "analyze", kind = "agent", instructions = "Analyze", allowed_domains = ["https://example.test/path"] }]
      delivery    = { step = "analyze" }
    } }
  }
  expect_failures = [var.workflows]
}

run "reject_development_without_gate" {
  command = plan
  variables {
    workflows = { development = {
      description = "Broken development"
      steps       = [{ name = "plan", kind = "plan", instructions = "Plan" }, { name = "build", kind = "build", instructions = "Build" }]
      delivery    = { kind = "draft_pr", step = "build" }
    } }
  }
  expect_failures = [var.workflows]
}

run "reject_invalid_tool" {
  command = plan
  variables { workflows = { analysis = {
    description = "Analysis"

    steps    = [{ name = "analyze", kind = "agent", instructions = "Analyze", tools = ["Read"] }]
    delivery = { step = "analyze" }
  } } }
  expect_failures = [var.workflows]
}

run "reject_invalid_extension" {
  command = plan
  variables { workflows = { analysis = {
    description = "Analysis"

    steps    = [{ name = "analyze", kind = "agent", instructions = "Analyze", extensions = ["relative.ts"] }]
    delivery = { step = "analyze" }
  } } }
  expect_failures = [var.workflows]
}

run "reject_invalid_model" {
  command = plan
  variables { workflows = { analysis = {
    description = "Analysis"

    steps    = [{ name = "analyze", kind = "agent", instructions = "Analyze", model = "" }]
    delivery = { step = "analyze" }
  } } }
  expect_failures = [var.workflows]
}

run "reject_invalid_runner_tag" {
  command = plan
  variables { workflows = { analysis = {
    description  = "Analysis"
    runner_image = "example/runner:current"
    steps        = [{ name = "analyze", kind = "agent", instructions = "Analyze" }]
    delivery     = { step = "analyze" }
  } } }
  expect_failures = [var.workflows]
}

run "recovery_and_timeout_policy" {
  command = plan
  variables {
    workflows = { analysis = {
      description = "Timeout and retry fixture"
      steps       = [{ name = "analyze", kind = "agent", instructions = "Analyze", retries = 2, capacity = "spot" }]
      delivery    = { step = "analyze" }
    } }
    alarm_actions = ["arn:aws:sns:us-east-1:123456789012:mork-alerts"]
  }
  assert {
    condition     = alltrue([for retry in local.workflow_definitions.analysis.States.step_analyze.Retry : !contains(retry.ErrorEquals, "States.Timeout")]) && alltrue([for retry in local.workflow_definitions.analysis.States.fallback_analyze.Retry : !contains(retry.ErrorEquals, "States.Timeout")]) && local.workflow_definitions.analysis.States.step_analyze.Catch[1].Next == "Failed"
    error_message = "A timed-out container must go through cleanup instead of overlapping a new attempt."
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.slack.destination_config[0].on_failure[0].destination == aws_sqs_queue.slack_failures[0].arn && aws_sqs_queue.slack_failures[0].message_retention_seconds == 1209600 && aws_sqs_queue.slack_failures[0].sqs_managed_sse_enabled
    error_message = "Failed async Slack requests must have an encrypted retained destination."
  }
  assert {
    condition     = contains([for statement in data.aws_iam_policy_document.slack.statement : statement.actions if statement.sid == "RetainFailedSlackRequests"][0], "sqs:SendMessage") && aws_cloudwatch_metric_alarm.slack_errors[0].alarm_actions == toset(var.alarm_actions) && length(aws_cloudwatch_metric_alarm.workflow_failures) == 2 && aws_cloudwatch_metric_alarm.slack_failures[0].metric_name == "ApproximateNumberOfMessagesVisible"
    error_message = "The destination needs IAM authorization and Slack/workflow failure alarms."
  }
  assert {
    condition     = local.workflow_definitions.analysis.TimeoutSeconds == local.workflow_seconds.analysis && jsondecode(aws_s3_object.slack_config.content).definitions.analysis.steps[0].instructions == "Analyze"
    error_message = "The workflow must have a complete lifetime budget and render approvals/configuration for runtime preflight."
  }
}

run "reject_wait_beyond_retention" {
  command = plan
  variables {
    workflows = { review = {
      description = "Long approval"
      steps       = [{ name = "approve", kind = "approval", instructions = "Approve?", timeout_seconds = 25920000 }]
      delivery    = { step = "approve" }
    } }
  }
  expect_failures = [aws_s3_bucket_lifecycle_configuration.mork]
}

run "long_wait_with_sufficient_retention" {
  command = plan
  variables {
    bucket_expiration_days = 365
    workflows = { review = {
      description = "Long approval"
      steps       = [{ name = "approve", kind = "approval", instructions = "Approve?", timeout_seconds = 25920000 }]
      delivery    = { step = "approve" }
    } }
  }
  assert {
    condition     = local.workflow_definitions.review.TimeoutSeconds > 25920000 && aws_s3_bucket_lifecycle_configuration.mork.rule[0].expiration[0].days == 365
    error_message = "Long human waits need corresponding artifact retention."
  }
}

run "reject_invalid_slack_project" {
  command = plan
  variables {
    decision_providers = [{ name = "jev" }]
    slack_channels     = { CDEMO = { repo = "acme/widgets", jira_project = "proj" } }
  }
  expect_failures = [var.slack_channels]
}

run "reject_invalid_slack_channel" {
  command = plan
  variables {
    decision_providers = [{ name = "jev" }]
    slack_channels     = { c0lower = { repo = "acme/widgets", jira_project = "PROJ" } }
  }
  expect_failures = [var.slack_channels]
}

run "reject_large_instructions" {
  command = plan
  variables {
    workflows = { review = {
      description = "Oversized prompt"
      steps       = [{ name = "approve", kind = "approval", instructions = join("", [for i in range(1000) : "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]) }]
      delivery    = { step = "approve" }
    } }
  }
  expect_failures = [var.workflows]
}

run "logs_to_otlp_without_cloudwatch" {
  command = plan
  variables {
    log_destination = "otlp"
    otlp_endpoint   = "http://otlp.internal.example:4318"
    otlp_cidr_block = "10.20.0.0/16"
  }
  assert {
    condition     = aws_lambda_function.steps.environment[0].variables.MORK_ENV == var.environment
    error_message = "The steps Lambda must use the same environment as runner logs."
  }
  assert {
    condition     = local.definition.States.Ask.Next == "MarkResumed" && local.definition.States.MarkResumed.ResultPath == "$.brief.run.resume" && local.definition.States.Start.Parameters.Payload["started_at.$"] == "$$.Execution.StartTime" && contains([for env in local.definition.States.Plan.Parameters.Overrides.ContainerOverrides[0].Environment : env.Name], "MORK_PHASE_STARTED_AT")
    error_message = "Run creation, resumption and phase times must come from Step Functions rather than Lambda retries."
  }
  assert {
    condition     = length(aws_cloudwatch_log_group.lambda) == 0 && length(aws_cloudwatch_log_group.slack) == 0 && length(aws_cloudwatch_log_group.stations) == 0 && length(aws_cloudwatch_log_group.sfn) == 0 && length(aws_sfn_state_machine.this.logging_configuration) == 0
    error_message = "With log_destination otlp nothing may log to CloudWatch."
  }
  assert {
    condition     = length(aws_iam_role_policy_attachment.lambda_logs) == 0 && length(aws_iam_role_policy_attachment.slack_logs) == 0 && length(aws_iam_role_policy_attachment.lambda_vpc) == 3 && length(aws_lambda_function.steps.vpc_config) == 1 && length(aws_lambda_function.slack.vpc_config) == 1 && aws_lambda_function.steps.environment[0].variables.OTEL_EXPORTER_OTLP_ENDPOINT == var.otlp_endpoint
    error_message = "Lambdas must reach the internal collector from the VPC, without CloudWatch log permissions."
  }
  assert {
    condition     = alltrue([for phase in ["plan", "build", "check"] : alltrue([for container in jsondecode(aws_ecs_task_definition.phase[phase].container_definitions) : !can(container.logConfiguration)])]) && contains([for env in jsondecode(aws_ecs_task_definition.phase["build"].container_definitions)[1].environment : env.value if env.name == "OTEL_EXPORTER_OTLP_ENDPOINT"], var.otlp_endpoint)
    error_message = "Containers keep no CloudWatch log; the egress proxy exports its audit over OTLP."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.slack_errors) == 0 && length(aws_sqs_queue.slack_failures) == 0 && length(aws_lambda_function_event_invoke_config.slack.destination_config) == 0
    error_message = "Without alarm_actions there are no alarms and no failure queue."
  }
}

run "reject_otlp_logs_without_endpoint" {
  command = plan
  variables {
    log_destination = "otlp"
  }
  expect_failures = [var.log_destination]
}
