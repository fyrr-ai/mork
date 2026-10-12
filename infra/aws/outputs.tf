output "webhook_url" {
  description = "GitHub webhook endpoint: content type JSON; events Issues, Pull requests, Pull request reviews, Pull request review comments, Issue comments and Check suites."
  value       = aws_lambda_function_url.intake.function_url
}

output "state_machine_arn" {
  description = "Mork workflow."
  value       = aws_sfn_state_machine.this.arn
}

output "ecr_repositories" {
  description = "Image repositories scripts/deploy.sh pushes to."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "lambda_functions" {
  description = "Functions scripts/deploy.sh points at the new image."
  value       = { steps = aws_lambda_function.steps.function_name, intake = aws_lambda_function.intake.function_name, slack = aws_lambda_function.slack.function_name }
}

output "slack_events_url" {
  description = "Request URL for the Slack app's Event Subscriptions."
  value       = aws_lambda_function_url.slack.function_url
}
