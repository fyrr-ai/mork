# Reuse the steps Lambda for terminal events. No polling, new database or exporter.
resource "aws_cloudwatch_event_rule" "execution_status" {
  count = var.otlp_endpoint == null ? 0 : 1
  name  = "${local.name}-execution-status"
  tags  = local.tags
  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [aws_sfn_state_machine.this.arn]
      status          = ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "execution_status" {
  count = var.otlp_endpoint == null ? 0 : 1
  rule  = aws_cloudwatch_event_rule.execution_status[0].name
  arn   = aws_lambda_function.steps.arn
}

resource "aws_lambda_permission" "execution_status" {
  count         = var.otlp_endpoint == null ? 0 : 1
  statement_id  = "ExecutionStatusEvents"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.steps.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.execution_status[0].arn
}
