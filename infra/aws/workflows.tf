# Configured steps use the shared runner image, cluster and steps Lambda.
# Pin task-definition revisions so a deployment cannot change a running task.
locals {
  # One canonical default is also used by the local runner and prompt tests.
  development          = jsondecode(lookup({ for name, workflow in var.workflows : name => jsonencode(workflow) }, "development", file("${path.module}/../../packages/contracts/src/development.json")))
  development_steps    = { for step in local.development.steps : step.kind => step }
  development_names    = { for step in local.development.steps : step.kind => title(step.name) }
  development_policy   = { questions = local.development.questions, fixes = local.development.fixes, repairs = local.development.repairs, build_attempts = local.development_steps.build.attempts }
  configured_workflows = { for name, workflow in var.workflows : name => workflow if name != "development" }
  workflow_steps = merge({}, [for name, workflow in local.configured_workflows : {
    for step in workflow.steps : "${name}.${step.name}" => {
      workflow = name
      step     = merge(step, { output_schema = jsondecode(step.output_schema) })
    } if step.kind != "approval"
  }]...)
  # Budgets have no resource dependencies, so retention can validate them before creation.
  development_seconds = local.development.questions.timeout_seconds * local.development.questions.max + sum([
    for step in local.development.steps : (
      (step.kind == "plan" ? 1 : max(local.development_steps.build.attempts, local.development.fixes.attempts) + local.development.repairs.rounds) + local.development.questions.max
    ) * (step.timeout_seconds * (step.capacity == "spot" ? 2 * step.spot_retries + 2 : 1) + (step.capacity == "spot" ? 40 * (pow(2, step.spot_retries) - 1) : 0))
  ]) + 3600
  workflow_seconds = { for name, workflow in local.configured_workflows : name => 3600 + sum([
    for step in workflow.steps : step.kind == "approval" ? step.timeout_seconds + 600 :
    (step.timeout_seconds * (step.retries + 1) + 5 * (pow(2, step.retries) - 1)) *
    (step.capacity == "spot" ? 2 * step.spot_retries + 2 : 1) +
    (step.capacity == "spot" ? 40 * (pow(2, step.spot_retries) - 1) : 0) + 600
  ]) }
  workflow_prefix  = "${aws_s3_bucket.mork.arn}/tasks/workflows"
  station_template = jsondecode(aws_ecs_task_definition.phase["plan"].container_definitions)
}

resource "aws_iam_role" "workflow_step" {
  for_each           = local.workflow_steps
  name               = "${local.name}_wf_${substr(sha256(each.key), 0, 16)}"
  tags               = local.tags
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "workflow_step" {
  for_each = local.workflow_steps
  role     = aws_iam_role.workflow_step[each.key].id
  name     = "artifacts"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"], Resource = "*" },
    { Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.mork.arn,
    Condition = { StringLike = { "s3:prefix" = ["tasks/workflows/${each.value.workflow}/*"] } } },
    { Effect = "Allow", Action = "s3:GetObject", Resource = concat(
      [for input in each.value.step.inputs : "${local.workflow_prefix}/${each.value.workflow}/*/steps/${input}/output.json"],
      ["${local.workflow_prefix}/${each.value.workflow}/*/run.json"],
      ["${local.workflow_prefix}/${each.value.workflow}/*/steps/${each.value.step.name}/*"]
    ) },
    { Effect = "Allow", Action = "s3:PutObject", Resource = "${local.workflow_prefix}/${each.value.workflow}/*/steps/${each.value.step.name}/*" },
  ] })
}

resource "aws_iam_role" "workflow_exec" {
  for_each           = local.workflow_steps
  name               = "${local.name}_wf_exec_${substr(sha256(each.key), 0, 16)}"
  tags               = local.tags
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "workflow_exec" {
  for_each   = local.workflow_steps
  role       = aws_iam_role.workflow_exec[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "workflow_exec" {
  for_each = local.workflow_steps
  role     = aws_iam_role.workflow_exec[each.key].id
  name     = "secrets"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = "secretsmanager:GetSecretValue",
    Resource = concat([data.aws_secretsmanager_secret.this["llm_api_key"].arn], values(each.value.step.secrets))
  }] })
}

resource "aws_ecs_task_definition" "workflow_step" {
  # Executions retain the pinned revision across deployments and approval waits.
  skip_destroy             = true
  for_each                 = local.workflow_steps
  tags                     = local.tags
  family                   = "${local.name}_wf_${substr(sha256(each.key), 0, 16)}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.station_size.cpu
  memory                   = var.station_size.memory
  execution_role_arn       = aws_iam_role.workflow_exec[each.key].arn
  task_role_arn            = aws_iam_role.workflow_step[each.key].arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  ephemeral_storage { size_in_gib = var.station_size.storage_gib }
  volume { name = "egress-ca" }

  container_definitions = jsonencode([
    merge(local.station_template[0], {
      image   = coalesce(var.workflows[each.value.workflow].runner_image, local.station_template[0].image)
      command = ["node", "packages/runner/src/workflow-main.ts"]
      environment = [
        { name = "MORK_BUCKET", value = aws_s3_bucket.mork.bucket },
        { name = "MORK_WORKFLOW_NAME", value = each.value.workflow },
        { name = "MORK_WORKFLOW_STEP", value = jsonencode(each.value.step) },
        { name = "MORK_MODEL", value = var.model },
        { name = "LLM_BASE_URL", value = var.llm_base_url },
        { name = "AWS_REGION", value = data.aws_region.current.region },
      ]
      secrets = [for name, arn in each.value.step.secrets : { name = "STEP_SECRET_${name}", valueFrom = arn }]
      logConfiguration = merge(local.station_template[0].logConfiguration, {
        options = merge(local.station_template[0].logConfiguration.options, { awslogs-stream-prefix = each.key })
      })
    }),
    merge(local.station_template[1], {
      environment = [
        { name = "MORK_LLM_HOST", value = regex("^https?://([^/:]+)", var.llm_base_url)[0] },
        { name = "MORK_EGRESS_ALLOW", value = join(",", each.value.step.allowed_domains) },
        { name = "MORK_EGRESS_WARN", value = tostring(!var.egress_enforce) },
      ]
      secrets = [{ name = "LLM_API_KEY", valueFrom = data.aws_secretsmanager_secret.this["llm_api_key"].arn }]
    })
  ])
}

resource "aws_iam_role" "workflow_sfn" {
  for_each           = local.configured_workflows
  name               = "${local.name}_wf_sfn_${substr(sha256(each.key), 0, 16)}"
  tags               = local.tags
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

resource "aws_iam_role_policy" "workflow_sfn" {
  for_each = local.configured_workflows
  role     = aws_iam_role.workflow_sfn[each.key].id
  name     = "workflow"
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = "${aws_lambda_function.steps.arn}:*" },
    { Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
    "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" },
    ], length([for step in each.value.steps : step if step.kind != "approval"]) == 0 ? [] : [
    { Effect   = "Allow", Action = "ecs:RunTask",
      Resource = [for key, td in aws_ecs_task_definition.workflow_step : "${td.arn_without_revision}:*" if local.workflow_steps[key].workflow == each.key],
    Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.this.arn } } },
    { Effect = "Allow", Action = "iam:PassRole",
      Resource = concat(
        [for key, role in aws_iam_role.workflow_step : role.arn if local.workflow_steps[key].workflow == each.key],
      [for key, role in aws_iam_role.workflow_exec : role.arn if local.workflow_steps[key].workflow == each.key]),
    Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
  ]) })
}

locals {
  workflow_lambda_retry = concat(local.lambda_retry, [{ ErrorEquals = ["States.TaskFailed"], IntervalSeconds = 2, MaxAttempts = 2, BackoffRate = 2 }])
  workflow_catch        = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "Failed" }]
  workflow_task_states = { for name, workflow in local.configured_workflows : name => { for index, step in workflow.steps : "step_${step.name}" => {
    Type             = "Task"
    Resource         = "arn:aws:states:::ecs:runTask.waitForTaskToken"
    TimeoutSeconds   = step.timeout_seconds
    HeartbeatSeconds = 300
    ResultPath       = "$.last"
    Catch            = concat(step.capacity == "spot" ? [{ ErrorEquals = local.spot_errors, ResultPath = "$.error", Next = "fallback_${step.name}" }] : [], local.workflow_catch)
    Parameters = {
      Cluster                  = aws_ecs_cluster.this.arn
      TaskDefinition           = aws_ecs_task_definition.workflow_step["${name}.${step.name}"].arn
      CapacityProviderStrategy = step.capacity == "spot" ? local.spot : local.on_demand
      NetworkConfiguration     = local.network
      "Group.$"                = "$.run.execution_arn"
      Overrides = { ContainerOverrides = [{
        Name = "station"
        Environment = [
          { Name = "MORK_TASK_TOKEN", "Value.$" = "$$.Task.Token" },
          { Name = "MORK_WORKFLOW_EXECUTION", "Value.$" = "$.run.execution" },
        ]
      }] }
    }
    Retry = concat(step.capacity == "spot" ? [
      { ErrorEquals = ["Mork.Interrupted"], MaxAttempts = step.spot_retries, IntervalSeconds = 10, BackoffRate = 2 },
      { ErrorEquals = ["ECS.AmazonECSException", "AmazonECS.Unknown"], MaxAttempts = step.spot_retries, IntervalSeconds = 30, BackoffRate = 2 },
    ] : [], [{ ErrorEquals = ["States.TaskFailed"], MaxAttempts = step.retries, IntervalSeconds = 5, BackoffRate = 2 }])
    Next = index + 1 < length(workflow.steps) ? "step_${workflow.steps[index + 1].name}" : "Report"
  } if step.kind != "approval" } }

  workflow_definitions = { for name, workflow in local.configured_workflows : name => {
    Comment        = workflow.description
    TimeoutSeconds = local.workflow_seconds[name]
    StartAt        = "Start"
    States = merge(
      local.workflow_task_states[name],
      { for step in workflow.steps : "fallback_${step.name}" => merge(local.workflow_task_states[name]["step_${step.name}"], {
        Catch      = local.workflow_catch,
        Retry      = [{ ErrorEquals = ["States.TaskFailed"], MaxAttempts = step.retries, IntervalSeconds = 5, BackoffRate = 2 }],
        Parameters = merge(local.workflow_task_states[name]["step_${step.name}"].Parameters, { CapacityProviderStrategy = local.on_demand })
      }) if step.kind != "approval" && step.capacity == "spot" },
      { for step in workflow.steps : "step_${step.name}" => {
        Type           = "Task"
        Resource       = "arn:aws:states:::lambda:invoke.waitForTaskToken"
        TimeoutSeconds = step.timeout_seconds
        ResultPath     = "$.last"
        Catch          = local.workflow_catch
        Parameters = {
          FunctionName = aws_lambda_function.steps.qualified_arn
          Payload      = { action = "workflow.approval", "run.$" = "$.run", step = merge(step, { output_schema = jsondecode(step.output_schema) }), "task_token.$" = "$$.Task.Token" }
        }
        Retry = local.workflow_lambda_retry
        Next  = "approved_${step.name}"
      } if step.kind == "approval" },
      { for step in workflow.steps : "approved_${step.name}" => {
        Type    = "Choice"
        Choices = [{ And = [{ Variable = "$.last.approved", IsPresent = true }, { Variable = "$.last.approved", BooleanEquals = true }], Next = "record_${step.name}" }]
        Default = "Rejected"
      } if step.kind == "approval" },
      { for index, step in workflow.steps : "record_${step.name}" => {
        Type       = "Task", Resource = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = { action = "workflow.approved", "run.$" = "$.run", step = step.name, "approved.$" = "$.last.approved" } }
        ResultPath = null, Retry = local.workflow_lambda_retry, Catch = local.workflow_catch
        Next       = index + 1 < length(workflow.steps) ? "step_${workflow.steps[index + 1].name}" : "Report"
      } if step.kind == "approval" },
      { for state in ["Rejected"] : state => {
        Type = "Pass", Result = { Error = "Mork.Rejected", Cause = "Requester rejected the approval" }, ResultPath = "$.error", Next = "Failed"
      } if anytrue([for step in workflow.steps : step.kind == "approval"]) },
      {
        Start = {
          Type = "Task", Resource = "arn:aws:states:::lambda:invoke"
          Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = {
            action = "workflow.start", workflow = name, "input.$" = "$", "execution.$" = "$$.Execution.Name", "execution_arn.$" = "$$.Execution.Id"
          } }
          ResultSelector = { "run.$" = "$.Payload" }
          Retry          = local.workflow_lambda_retry
          # Start may fail before a valid run exists, so it remains a native failure.
          Next = "step_${workflow.steps[0].name}"
        }
        Report = {
          Type       = "Task", Resource = "arn:aws:states:::lambda:invoke"
          Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = { action = "workflow.report", "run.$" = "$.run", step = workflow.delivery.step } }
          OutputPath = "$.Payload", Retry = local.workflow_lambda_retry, Catch = local.workflow_catch, End = true
        }
        Failed = {
          Type       = "Task", Resource = "arn:aws:states:::lambda:invoke"
          Parameters = { FunctionName = aws_lambda_function.steps.qualified_arn, Payload = { action = "workflow.failed", "run.$" = "$.run", "error.$" = "$.error" } }
          ResultPath = null, Retry = local.workflow_lambda_retry, Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.notification_error", Next = "Failure" }], Next = "Failure"
        }
        Failure = { Type = "Fail", Error = "Mork.WorkflowFailed", Cause = "A step failed or the requester rejected approval; inspect execution history." }
      }
    )
  } }
}

resource "aws_sfn_state_machine" "workflow" {
  for_each   = local.configured_workflows
  tags       = local.tags
  name       = "${local.name}_${each.key}"
  role_arn   = aws_iam_role.workflow_sfn[each.key].arn
  type       = "STANDARD"
  definition = jsonencode(local.workflow_definitions[each.key])
  lifecycle {
    precondition {
      condition     = local.workflow_seconds[each.key] <= 31536000
      error_message = "The complete configured workflow including retries must fit within one year."
    }
  }
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }
}

resource "aws_s3_object" "slack_config" {
  bucket       = aws_s3_bucket.mork.bucket
  key          = "config/slack.json"
  content_type = "application/json"
  content = jsonencode({
    definitions = merge({ development = local.development }, local.configured_workflows)
    channels    = var.slack_channels
    confidence  = var.routing_confidence
    workflows = merge({ development = {
      arn = "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}", kind = "development", description = local.development.description
      } }, { for name, workflow in local.configured_workflows : name => {
      arn = "arn:aws:states:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}_${name}", kind = "configured", description = workflow.description
    } })
  })
}
