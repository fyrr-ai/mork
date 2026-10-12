# The workflow:
#
#   Start → Route (triage: an unclear issue ends here, or asks on Slack)
#   Route:  plan  → Plan → Build → Check → Decide → Route
#           build → Build (a new attempt, at most 3)
#           ask   → Ask
#           done  → Done
#   After each phase, <Phase>Asked → Ask when the station asked the requester.
#   Ask waits (up to answer_seconds) for the Slack answer, then Resume reruns
#   the phase that asked (or Plan after a triage question).
#
# Plan, Build and Check are Fargate containers started with
# ecs:runTask.waitForTaskToken; Build pushes its branch itself. Start, Decide
# and Handover are the steps Lambda. Every state catches into Handover, which
# reports, labels and stops whatever container still runs.

resource "aws_cloudwatch_log_group" "sfn" {
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
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups",
    ]
    resources = ["*"]
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

  catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "Handover" }]

  # Phases start on Fargate Spot. When spot_attempts retries after
  # interruptions or capacity shortages run out, the task moves to on-demand
  # Fargate (SpotFallback); a failure there goes to a person.
  spot        = [{ CapacityProvider = "FARGATE_SPOT", Weight = 1 }]
  on_demand   = [{ CapacityProvider = "FARGATE", Weight = 1 }]
  spot_errors = ["Mork.Interrupted", "ECS.AmazonECSException", "AmazonECS.Unknown"]

  # A phase is one state: Step Functions starts the container with the task
  # token and the brief and waits until it reports back. Missing heartbeats
  # (crash, hang) fail the state within five minutes.
  phase = { for name, next in { Plan = "Build", Build = "Check", Check = "Decide" } : name => {
    Type             = "Task"
    Resource         = "arn:aws:states:::ecs:runTask.waitForTaskToken"
    TimeoutSeconds   = var.phase_seconds[lower(name)]
    HeartbeatSeconds = 300
    ResultPath       = "$.last"
    # Spot reclaim (the runner reports Mork.Interrupted) and Fargate capacity
    # shortages rerun the phase. A RunTask call that fails raises
    # ECS.AmazonECSException; one that returns Failures (no capacity) raises
    # AmazonECS.Unknown.
    Retry = [
      { ErrorEquals = ["Mork.Interrupted"], MaxAttempts = var.spot_attempts, IntervalSeconds = 10, BackoffRate = 2 },
      { ErrorEquals = ["ECS.AmazonECSException", "AmazonECS.Unknown"], MaxAttempts = var.spot_attempts, IntervalSeconds = 30, BackoffRate = 2 },
    ]
    Catch = concat(
      [{ ErrorEquals = local.spot_errors, ResultPath = "$.error", Next = "SpotFallback", Assign = { failed_phase = name } }],
      local.catch,
    )
    Next = "${name}Asked"
    Parameters = {
      Cluster                      = aws_ecs_cluster.this.arn
      TaskDefinition               = aws_ecs_task_definition.phase[lower(name)].arn_without_revision
      "CapacityProviderStrategy.$" = "$capacity"
      NetworkConfiguration         = local.network
      "Group.$"                    = "$.task.started_by"
      Overrides = {
        ContainerOverrides = [{
          Name = "station"
          Environment = [
            { Name = "MORK_TASK_TOKEN", "Value.$" = "$$.Task.Token" },
            { Name = "MORK_BRIEF", "Value.$" = "States.JsonToString($.brief)" },
          ]
          }, {
          # The sidecar injects the push token only for this task's repository.
          Name        = "egress"
          Environment = [{ Name = "MORK_REPO", "Value.$" = "$.brief.repo.full_name" }]
        }]
      }
    }
  } }

  # A station that asked the requester ends with `question` in its result.
  asked = { for name, next in { Plan = "Build", Build = "Check", Check = "Decide" } : "${name}Asked" => {
    Type    = "Choice"
    Choices = [{ Variable = "$.last.question", IsPresent = true, Next = "Ask" }]
    Default = next
  } }

  lambda_retry = [{ ErrorEquals = ["Lambda.ServiceException", "Lambda.TooManyRequestsException", "Lambda.SdkClientException"], MaxAttempts = 3, IntervalSeconds = 5, BackoffRate = 2 }]

  # A step returns the next state or throws Handover with the reason.
  step = { for name, action in { Decide = "decide" } : name => {
    Type       = "Task"
    Resource   = "arn:aws:states:::lambda:invoke"
    Parameters = { FunctionName = aws_lambda_function.steps.arn, Payload = { action = action, "state.$" = "$" } }
    OutputPath = "$.Payload"
    Retry      = local.lambda_retry
    Catch      = local.catch
    Next       = "Route"
  } }

  definition = {
    Comment = "Mork: a GitHub issue or Slack request to a reviewed draft PR, and fixes on that PR"
    # Backstop for the whole task: three phases, retries and a question waiting up to answer_seconds.
    TimeoutSeconds = var.answer_seconds + 3 * 7200 + 3600
    StartAt        = "Start"
    States = merge(local.phase, local.asked, local.step, {
      Start = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.steps.arn
          # The whole execution input goes on: { repo, issue } from GitHub or SlackStart from Slack.
          Payload = { action = "start", "input.$" = "$", "execution.$" = "$$.Execution.Name", "execution_arn.$" = "$$.Execution.Id" }
        }
        OutputPath = "$.Payload"
        Assign     = { capacity = local.spot, on_demand = false }
        Retry      = local.lambda_retry
        Catch      = local.catch
        Next       = "Route"
      }
      SpotFallback = {
        Type = "Choice"
        Choices = concat(
          [{ Variable = "$on_demand", BooleanEquals = true, Next = "Handover" }],
          [for name in ["Plan", "Build", "Check"] : {
            Variable     = "$failed_phase"
            StringEquals = name
            Next         = name
            Assign       = { capacity = local.on_demand, on_demand = true }
          }],
        )
        Default = "Handover"
      }
      Route = {
        Type = "Choice"
        Choices = [
          { Variable = "$.next", StringEquals = "plan", Next = "Plan" },
          { Variable = "$.next", StringEquals = "build", Next = "Build" },
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
          FunctionName = aws_lambda_function.steps.arn
          Payload      = { action = "ask", "state.$" = "$", "task_token.$" = "$$.Task.Token" }
        }
        TimeoutSeconds = var.answer_seconds
        ResultPath     = "$.last"
        Retry          = local.lambda_retry
        Catch          = local.catch
        Next           = "Resume"
      }
      Resume = {
        Type = "Choice"
        Choices = [
          { Variable = "$.last.resume", StringEquals = "plan", Next = "Plan" },
          { Variable = "$.last.resume", StringEquals = "build", Next = "Build" },
          { Variable = "$.last.resume", StringEquals = "check", Next = "Check" },
        ]
        Default = "Handover"
      }
      Handover = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.steps.arn, Payload = { action = "handover", "state.$" = "$" } }
        OutputPath = "$.Payload"
        Retry      = [{ ErrorEquals = ["States.ALL"], MaxAttempts = 2, IntervalSeconds = 10, BackoffRate = 2 }]
        Next       = "Done"
      }
      Done = { Type = "Succeed" }
    })
  }
}

resource "aws_sfn_state_machine" "this" {
  name       = local.name
  role_arn   = aws_iam_role.sfn.arn
  type       = "STANDARD"
  definition = jsonencode(local.definition)

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }
}
