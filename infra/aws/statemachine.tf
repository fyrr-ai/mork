# The workflow:
#
#   Start → Route (triage: an unclear issue ends here, or asks on Slack)
#   Route:  plan  → Plan → Build → Check → Decide → Route
#           build → Build (a new attempt, at most 3)
#           ask   → Ask
#           done  → Done
#   After each phase, <Phase>Asked → Ask when the station asked the requester.
#   Ask waits (up to the configured question timeout) for the Slack answer, then Resume reruns
#   the phase that asked (or Plan after a triage question).
#
# Plan, Build and Check are Fargate containers started with
# ecs:runTask.waitForTaskToken; Build pushes its branch itself. Start, Decide
# and Handover are the steps Lambda. Every state catches into Handover, which
# reports, labels and stops whatever container still runs.

resource "aws_cloudwatch_log_group" "sfn" {
  count             = local.cloudwatch_logs ? 1 : 0
  tags              = local.tags
  name              = "/aws/vendedlogs/states/${local.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  tags               = local.tags
  name               = "${local.name}_sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn" {
  statement {
    sid       = "RunStations"
    actions   = ["ecs:RunTask"]
    resources = [for td in aws_ecs_task_definition.phase : "${td.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "PassStationRoles"
    actions   = ["iam:PassRole"]
    resources = concat([aws_iam_role.station_exec.arn], [for r in aws_iam_role.phase : r.arn])
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "InvokeSteps"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.steps.arn, "${aws_lambda_function.steps.arn}:*"]
  }
  dynamic "statement" {
    for_each = local.cloudwatch_logs ? [1] : []
    content {
      sid = "Logs"
      actions = [
        "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "sfn" {
  name   = "workflow"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

locals {
  network = {
    AwsvpcConfiguration = {
      Subnets        = var.vpc_private_subnet_ids
      SecurityGroups = [aws_security_group.stations.id]
      AssignPublicIp = "DISABLED"
    }
  }

  development_runtime = {
    image              = jsondecode(aws_ecs_task_definition.phase["plan"].container_definitions)[0].image
    platform           = "linux/arm64"
    repository_runtime = try(local.development.runner_image, null) != null
    task_definitions   = { for phase, definition in aws_ecs_task_definition.phase : phase => definition.arn }
  }

  catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "Handover" }]

  spot        = [{ CapacityProvider = "FARGATE_SPOT", Weight = 1 }]
  on_demand   = [{ CapacityProvider = "FARGATE", Weight = 1 }]
  spot_errors = ["Mork.Interrupted", "ECS.AmazonECSException", "AmazonECS.Unknown"]

  # Configuration names the operations; the compiler preserves their gate and
  # hidden-test boundaries. Each step has its own capacity choice and fallback.
  phase = { for index, step in local.development.steps : title(step.name) => {
    Type             = "Task"
    Resource         = "arn:aws:states:::ecs:runTask.waitForTaskToken"
    TimeoutSeconds   = step.timeout_seconds
    HeartbeatSeconds = 300
    ResultPath       = "$.last"
    Retry = step.capacity == "spot" ? [
      { ErrorEquals = ["Mork.Interrupted"], MaxAttempts = step.spot_retries, IntervalSeconds = 10, BackoffRate = 2 },
      { ErrorEquals = ["ECS.AmazonECSException", "AmazonECS.Unknown"], MaxAttempts = step.spot_retries, IntervalSeconds = 30, BackoffRate = 2 },
    ] : []
    Catch = concat(step.capacity == "spot" ? [
      { ErrorEquals = local.spot_errors, ResultPath = "$.error", Next = "${title(step.name)}OnDemand${step.kind == "check" ? "" : "Preflight"}" }
    ] : [], local.catch)
    Next = "${title(step.name)}Asked"
    Parameters = {
      Cluster                  = aws_ecs_cluster.this.arn
      "TaskDefinition.$"       = "$.brief.runtime.task_definitions.${step.kind}"
      CapacityProviderStrategy = step.capacity == "spot" ? local.spot : local.on_demand
      NetworkConfiguration     = local.network
      "Group.$"                = "$.task.started_by"
      Overrides = {
        ContainerOverrides = [{
          Name = "station"
          Environment = [
            { Name = "MORK_TASK_TOKEN", "Value.$" = "$$.Task.Token" },
            { Name = "MORK_BRIEF", "Value.$" = "States.JsonToString($.brief)" },
            { Name = "MORK_PHASE", Value = step.kind },
            { Name = "MORK_PHASE_STARTED_AT", "Value.$" = "$$.State.EnteredTime" },
          ]
          }, {
          Name        = "egress"
          Environment = [{ Name = "MORK_REPO", "Value.$" = "$.brief.repo.full_name" }]
        }]
      }
    }
  } }
  phase_fallback = { for step in local.development.steps : "${title(step.name)}OnDemand" => merge(local.phase[title(step.name)], {
    Retry      = [], Catch = local.catch,
    Parameters = merge(local.phase[title(step.name)].Parameters, { CapacityProviderStrategy = local.on_demand })
  }) if step.capacity == "spot" }
  asked = { for index, step in local.development.steps : "${title(step.name)}Asked" => {
    Type    = "Choice"
    Choices = [{ Variable = "$.last.question", IsPresent = true, Next = "Ask" }]
    Default = index + 1 < length(local.development.steps) ? "${title(local.development.steps[index + 1].name)}${local.development.steps[index + 1].kind == "check" ? "" : "Preflight"}" : "Decide"
  } }

  lambda_retry = [{ ErrorEquals = ["Lambda.ServiceException", "Lambda.TooManyRequestsException", "Lambda.SdkClientException"], MaxAttempts = 3, IntervalSeconds = 5, BackoffRate = 2 }]

  preflight = { for name, phase in merge(local.phase, local.phase_fallback) : "${name}Preflight" => {
    Type       = "Task"
    Resource   = "arn:aws:states:::lambda:invoke"
    Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = { action = "preflight", "state.$" = "$" } }
    OutputPath = "$.Payload"
    Retry      = local.lambda_retry
    Catch      = local.catch
    Next       = name
  } if name != local.development_names.check && name != "${local.development_names.check}OnDemand" }

  # A step returns the next state or throws Handover with the reason.
  step = { for name, action in { Decide = "decide" } : name => {
    Type       = "Task"
    Resource   = "arn:aws:states:::lambda:invoke"
    Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = { action = action, "state.$" = "$" } }
    OutputPath = "$.Payload"
    Retry      = local.lambda_retry
    Catch      = local.catch
    Next       = "Route"
  } }

  definition = {
    Comment = "Mork: a GitHub issue or Slack request to a reviewed draft PR, and fixes on that PR"
    # Budget configured work attempts, questions and both Spot retry categories plus on-demand fallback.
    TimeoutSeconds = local.development_seconds
    StartAt        = "Start"
    States = merge(local.phase, local.phase_fallback, local.asked, local.step, local.preflight, {
      Start = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.steps.qualified_arn
          # The whole execution input goes on: { repo, issue } from GitHub or SlackStart from Slack.
          Payload = { action = "start", "input.$" = "$", "execution.$" = "$$.Execution.Name", "execution_arn.$" = "$$.Execution.Id", "started_at.$" = "$$.Execution.StartTime", policy = local.development_policy, runtime = local.development_runtime }
        }
        OutputPath = "$.Payload"
        Retry      = local.lambda_retry
        Catch      = local.catch
        Next       = "Route"
      }
      Route = {
        Type = "Choice"
        Choices = [
          { Variable = "$.next", StringEquals = "plan", Next = "${local.development_names.plan}Preflight" },
          { Variable = "$.next", StringEquals = "build", Next = "${local.development_names.build}Preflight" },
          { Variable = "$.next", StringEquals = "ask", Next = "Ask" },
        ]
        Default = "Done"
      }
      # The steps Lambda posts the question and parks the task token; the Slack
      # intake sends it back with the answer. No answer in time → Handover.
      Ask = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke.waitForTaskToken"
        Parameters = {
          FunctionName = aws_lambda_function.steps.qualified_arn
          Payload      = { action = "ask", "state.$" = "$", "task_token.$" = "$$.Task.Token", "entered_at.$" = "$$.State.EnteredTime" }
        }
        TimeoutSeconds = local.development.questions.timeout_seconds
        ResultPath     = "$.last"
        Retry          = local.lambda_retry
        Catch          = local.catch
        Next           = "MarkResumed"
      }
      MarkResumed = {
        Type       = "Pass"
        Parameters = { "at.$" = "$$.State.EnteredTime" }
        ResultPath = "$.brief.run.resume"
        Next       = "Resume"
      }
      Resume = {
        Type = "Choice"
        Choices = [
          { Variable = "$.last.resume", StringEquals = "plan", Next = "${local.development_names.plan}Preflight" },
          { Variable = "$.last.resume", StringEquals = "build", Next = "${local.development_names.build}Preflight" },
          { Variable = "$.last.resume", StringEquals = "check", Next = local.development_names.check },
        ]
        Default = "Handover"
      }
      Handover = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = { action = "handover", "state.$" = "$" } }
        OutputPath = "$.Payload"
        Retry      = [{ ErrorEquals = ["States.ALL"], MaxAttempts = 2, IntervalSeconds = 10, BackoffRate = 2 }]
        Catch      = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.handover_error", Next = "HandoverFailed" }]
        Next       = "Done"
      }
      HandoverFailed = { Type = "Fail", Error = "Mork.HandoverFailed", Cause = "Human notification or container cleanup failed after retries; inspect the execution history." }
      Done           = { Type = "Succeed" }
    })
  }
}

resource "aws_sfn_state_machine" "this" {
  tags       = local.tags
  name       = local.name
  role_arn   = aws_iam_role.sfn.arn
  type       = "STANDARD"
  definition = jsonencode(local.definition)

  lifecycle {
    precondition {
      condition     = local.definition.TimeoutSeconds <= 31536000
      error_message = "The workflow timeout must fit within the one-year Step Functions limit; reduce phase/answer timeouts or retries."
    }
  }

  # Without CloudWatch, failed executions are in their own execution history.
  dynamic "logging_configuration" {
    for_each = local.cloudwatch_logs ? [1] : []
    content {
      log_destination        = "${aws_cloudwatch_log_group.sfn[0].arn}:*"
      include_execution_data = false
      level                  = "ERROR"
    }
  }
}
