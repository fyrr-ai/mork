#!/usr/bin/env bash
# Follows a Mork execution and prints one line per state transition,
# then the final status. Defaults to the newest execution.
#   mise run e2e:watch [-- <execution-arn>]
set -euo pipefail
sm="arn:aws:states:${AWS_REGION}:$(aws sts get-caller-identity --query Account --output text):stateMachine:${MORK_STATE_MACHINE:-${MORK_NAME:-mork}}"
arn="${1:-$(aws stepfunctions list-executions --state-machine-arn "$sm" --max-results 1 --query 'executions[0].executionArn' --output text)}"
echo "execution: $arn"
seen=0
while true; do
  history="$(aws stepfunctions get-execution-history --execution-arn "$arn" --max-results 1000 --output json)"
  jq -r --argjson seen "$seen" '.events[$seen:][]
    | select(.type | test("StateEntered|ExecutionFailed|ExecutionSucceeded|TaskFailed|TaskTimedOut|ExecutionTimedOut"))
    | "\(.timestamp | tostring | .[11:19]) \(.type) \(.stateEnteredEventDetails.name // "") \(.taskFailedEventDetails.error // .taskTimedOutEventDetails.error // "") \((.taskFailedEventDetails.cause // .taskTimedOutEventDetails.cause // .executionFailedEventDetails.cause // "") | .[0:300])"' <<<"$history"
  seen="$(jq '.events | length' <<<"$history")"
  status="$(aws stepfunctions describe-execution --execution-arn "$arn" --query status --output text)"
  if [[ "$status" != "RUNNING" ]]; then
    echo "status: $status"
    aws stepfunctions describe-execution --execution-arn "$arn" --query output --output text | jq -c '{next, outcome}' 2>/dev/null || true
    break
  fi
  sleep 20
done
