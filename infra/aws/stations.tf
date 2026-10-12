# Phase containers: Plan (analyst, gate before), Build (implementer) and Check
# (gate after, reviewer). Step Functions starts them and passes the task token
# and the brief as overrides.

resource "aws_cloudwatch_log_group" "stations" {
  tags              = local.tags
  name              = "/ecs/${local.name}/stations"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pulls the image and injects the secrets: the LLM key and push token (sidecar), the read token and decision keys (station).
resource "aws_iam_role" "station_exec" {
  tags               = local.tags
  name               = "${local.name}_station_exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "station_exec_managed" {
  role       = aws_iam_role.station_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "station_exec_secrets" {
  statement {
    sid     = "InjectStationSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [
        data.aws_secretsmanager_secret.this["llm_api_key"].arn,
        data.aws_secretsmanager_secret.this["github_read_token"].arn,
        data.aws_secretsmanager_secret.this["github_push_token"].arn,
      ],
      [for s in data.aws_secretsmanager_secret.decision : s.arn],
    )
  }
}

resource "aws_iam_role_policy" "station_exec_secrets" {
  name   = "inject-station-secrets"
  role   = aws_iam_role.station_exec.id
  policy = data.aws_iam_policy_document.station_exec_secrets.json
}

# One task role per phase: report to Step Functions, read the outputs the
# phase needs and write only its own. Keys are fixed by convention under
# tasks/<owner>/<repo>/<issue>/<run>/. Pi and the gate run as other users
# with a clean environment and never see these credentials. Build is the only
# phase that cannot read hidden tests, and nothing but Check reads them later.
# Sessions are per phase: the analyst's session contains the hidden tests it
# wrote, so Build may only read and write its own (sessions/build-*).
locals {
  tasks_arn = "${aws_s3_bucket.mork.arn}/tasks"
  phases = {
    plan = {
      reads  = ["issue.json", "answers.json", "sessions/plan-*", "sessions/pending.json"]
      writes = ["plan.json", "hidden/*", "plan/*", "sessions/plan-*", "sessions/pending.json"]
    }
    build = {
      reads  = ["issue.json", "answers.json", "plan.json", "build/*/feedback.md", "sessions/build-*", "sessions/pending.json"]
      writes = ["build/*/output.json", "build/*/result.json", "build/*/supervision.json", "sessions/build-*", "sessions/pending.json"]
    }
    check = {
      reads  = ["issue.json", "answers.json", "plan.json", "hidden/*", "build/*/output.json", "build/*/result.json", "sessions/check-*", "sessions/pending.json"]
      writes = ["check/*", "build/*/feedback.md", "sessions/check-*", "sessions/pending.json"]
    }
  }
}

resource "aws_iam_role" "phase" {
  tags               = local.tags
  for_each           = local.phases
  name               = "${local.name}_${each.key}_task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "phase" {
  for_each = local.phases

  statement {
    # Task-token APIs have no resource type; the token is the authorization.
    sid       = "ReportToStepFunctions"
    actions   = ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"]
    resources = ["*"]
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
    sid       = "ReadInputs"
    actions   = ["s3:GetObject"]
    resources = [for key in each.value.reads : "${local.tasks_arn}/*/${key}"]
  }
  dynamic "statement" {
    for_each = each.key == "build" ? [1] : []
    content {
      sid       = "HiddenTestsStayHidden"
      effect    = "Deny"
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = ["${local.tasks_arn}/*/hidden/*", "${local.tasks_arn}/*/sessions/plan-*"]
    }
  }
  statement {
    sid       = "WriteOwnOutputs"
    actions   = ["s3:PutObject"]
    resources = [for key in each.value.writes : "${local.tasks_arn}/*/${key}"]
  }
  statement {
    # Slack tasks: the runner (not Pi) posts the phase's progress into the thread.
    sid       = "ReportToSlack"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.source_secret_arns.slack_bot_token]
  }
}

resource "aws_iam_role_policy" "phase" {
  for_each = local.phases
  name     = "phase"
  role     = aws_iam_role.phase[each.key].id
  policy   = data.aws_iam_policy_document.phase[each.key].json
}

# The three phase containers share the runner image; the task definition
# names the phase. Next to the station runs the egress sidecar (iron-proxy):
# it alone holds the LLM key, and in Build the push token, and adds them to
# the agent's requests for those hosts. The station trusts the sidecar's
# per-task CA through the shared egress-ca volume.
resource "aws_ecs_task_definition" "phase" {
  # Executions retain the pinned revision across deployments and approval waits.
  skip_destroy             = true
  tags                     = local.tags
  for_each                 = local.phases
  family                   = "${local.name}_${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.station_size.cpu
  memory                   = var.station_size.memory
  execution_role_arn       = aws_iam_role.station_exec.arn
  task_role_arn            = aws_iam_role.phase[each.key].arn

  lifecycle {
    precondition {
      condition     = length(var.image_digests) == 3
      error_message = "Supply immutable image digests for all three images."
    }
  }
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  ephemeral_storage {
    size_in_gib = var.station_size.storage_gib
  }

  volume {
    name = "egress-ca"
  }

  container_definitions = jsonencode([{
    name      = "station"
    image     = coalesce(try(local.development.runner_image, null), "${aws_ecr_repository.this["runner"].repository_url}@${lookup(var.image_digests, "runner", "sha256:missing")}")
    essential = true
    # SIGTERM → SIGKILL grace: the runner saves the session and the implementer's work.
    # ECS stops the station before the sidecar it depends on, so the last push still goes out.
    stopTimeout = 120
    dependsOn   = [{ containerName = "egress", condition = "HEALTHY" }]
    mountPoints = [{ sourceVolume = "egress-ca", containerPath = "/mork-egress", readOnly = true }]
    environment = concat([
      { name = "MORK_PHASE", value = each.key },
      { name = "MORK_DEVELOPMENT_STEP", value = jsonencode(local.development_steps[each.key]) },
      { name = "MORK_BUCKET", value = aws_s3_bucket.mork.bucket },
      { name = "MORK_MODEL", value = var.model },
      { name = "LLM_BASE_URL", value = var.llm_base_url },
      { name = "AWS_REGION", value = data.aws_region.current.region },
      { name = "MORK_SUPERVISE_SECONDS", value = tostring(var.supervise_seconds) },
      { name = "SLACK_BOT_TOKEN_SECRET_ID", value = local.source_secret_names.slack_bot_token },
      { name = "MORK_ENV", value = var.environment },
      ],
      # Live log over OTLP/HTTP (optional), e.g. to Grafana Alloy or an OpenTelemetry collector.
      var.otlp_endpoint == null ? [] : [{ name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otlp_endpoint }],
      var.otel_resource_attributes == "" ? [] : [{ name = "OTEL_RESOURCE_ATTRIBUTES", value = var.otel_resource_attributes }],
      [for k, v in local.decision_settings : { name = k, value = v }],
    )
    secrets = concat(
      [{ name = "GITHUB_READ_TOKEN", valueFrom = data.aws_secretsmanager_secret.this["github_read_token"].arn }],
      # Every phase supervises its LLM station; the runner, not Pi, holds these keys.
      [for p, s in data.aws_secretsmanager_secret.decision : { name = local.decision_env[p], valueFrom = s.arn }],
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.stations.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = each.key
      }
    }
    }, {
    name      = "egress"
    image     = "${aws_ecr_repository.this["egress"].repository_url}@${lookup(var.image_digests, "egress", "sha256:missing")}"
    essential = true
    environment = [
      { name = "MORK_LLM_HOST", value = regex("^https?://([^/:]+)", var.llm_base_url)[0] },
      { name = "MORK_EGRESS_ALLOW", value = join(",", local.development_steps[each.key].allowed_domains) },
      # "false" blocks hosts outside the allowlist; "true" only logs them.
      { name = "MORK_EGRESS_WARN", value = tostring(!var.egress_enforce) },
    ]
    secrets = concat(
      [{ name = "LLM_API_KEY", valueFrom = data.aws_secretsmanager_secret.this["llm_api_key"].arn }],
      # Build only: the implementer's pushes get this narrowed token here, never in its own environment.
      each.key == "build" ? [{ name = "GITHUB_PUSH_TOKEN", valueFrom = data.aws_secretsmanager_secret.this["github_push_token"].arn }] : [],
    )
    mountPoints = [{ sourceVolume = "egress-ca", containerPath = "/mork-egress" }]
    healthCheck = {
      command     = ["CMD-SHELL", "test -s /mork-egress/ca.crt && wget -q -O /dev/null http://127.0.0.1:9090/healthz"]
      interval    = 5
      timeout     = 3
      retries     = 6
      startPeriod = 5
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.stations.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "${each.key}-egress"
      }
    }
  }])
}

resource "aws_security_group" "stations" {
  tags        = local.tags
  name        = "${local.dash}-stations"
  description = "Mork station tasks: no ingress, HTTPS out"
  vpc_id      = var.vpc_id
}

# Containers clone from GitHub, install packages, call the LLM gateway and
# AWS APIs, whose addresses are not stable. The agent's traffic goes through
# the egress sidecar, which logs hosts outside its allowlist; the network
# itself is not restricted (Fargate allows no iptables inside the task). The
# agent holds no credentials, and the containers' AWS credentials reach outputs for their phase across tasks.
# trivy:ignore:AWS-0104
resource "aws_vpc_security_group_egress_rule" "stations_https" {
  tags              = local.tags
  security_group_id = aws_security_group.stations.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to GitHub, package registries, the LLM gateway and AWS APIs"
}

resource "aws_vpc_security_group_egress_rule" "stations_otlp" {
  tags              = local.tags
  count             = var.otlp_cidr_block == null ? 0 : 1
  security_group_id = aws_security_group.stations.id
  cidr_ipv4         = var.otlp_cidr_block
  ip_protocol       = "tcp"
  from_port         = 4318
  to_port           = 4318
  description       = "OTLP/HTTP live log"
}

resource "aws_vpc_security_group_egress_rule" "stations_dns" {
  tags              = local.tags
  security_group_id = aws_security_group.stations.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  description       = "VPC resolver"
}
