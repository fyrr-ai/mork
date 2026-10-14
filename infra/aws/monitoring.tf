# Alarms and the queue for failed Slack invocations exist only when someone is notified (alarm_actions).
# Retain failed asynchronous Slack requests for inspection and explicit replay.
resource "aws_sqs_queue" "slack_failures" {
  count                     = local.alarms ? 1 : 0
  name                      = "${local.dash}-slack-failures"
  tags                      = local.tags
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_cloudwatch_metric_alarm" "slack_errors" {
  count               = local.alarms ? 1 : 0
  alarm_name          = "${local.name}-slack-errors"
  alarm_description   = "Slack worker failed. Inspect Lambda logs and the failed-invocation queue."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.slack.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "slack_failures" {
  count               = local.alarms ? 1 : 0
  alarm_name          = "${local.name}-slack-failures"
  alarm_description   = "An asynchronous Slack invocation exhausted retries. Inspect and replay after fixing its cause."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.slack_failures[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "workflow_failures" {
  for_each            = local.alarms ? merge({ development = aws_sfn_state_machine.this.arn }, { for name, machine in aws_sfn_state_machine.workflow : name => machine.arn }) : {}
  alarm_name          = "${local.name}-${each.key}-failures"
  alarm_description   = "Workflow failed or timed out, including exhausted notification or cleanup. Inspect execution history."
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  tags                = local.tags
  metric_query {
    id          = "errors"
    expression  = "failed + timedout"
    return_data = true
  }
  dynamic "metric_query" {
    for_each = { failed = "ExecutionsFailed", timedout = "ExecutionsTimedOut" }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/States"
        metric_name = metric_query.value
        dimensions  = { StateMachineArn = each.value }
        period      = 300
        stat        = "Sum"
      }
    }
  }
}
