# Distributed encoding operations

The coordinator starts one fixed Fargate encoder per requested `360p` or `720p`
rendition. A failed or timed-out Step Functions execution does not prove that
every ECS child has stopped; optimized `ecs:runTask.sync` completion and
execution cancellation are best-effort observations.

For a failed execution, record only the execution ARN, job/attempt, rendition,
task ARN, and stop reason. Inspect tasks launched by that execution in the
dedicated environment before retrying the parent. Do not print the complete
task JSON: container overrides can contain `CHILD_PAYLOAD_JSON`.

```bash
aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --output json
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --output json \
  --query 'tasks[].{taskArn:taskArn,lastStatus:lastStatus,desiredStatus:desiredStatus,stopCode:stopCode,stoppedReason:stoppedReason,startedAt:startedAt,stoppedAt:stoppedAt,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,reason:reason}}'
```

Stop only confirmed residual encoder tasks from the failed execution, then
re-check `describe-tasks` until each reaches `STOPPED`. Bound this inspection
and cleanup window by the parent deadline; escalate tasks that remain running
after the window rather than assuming execution cancellation terminated them.
Never delete completed-job objects or objects belonging to another attempt.

## Live acceptance

In a dedicated environment, start one two-rendition payload and confirm the
execution history shows two distinct encoder task ARNs with overlapping running
intervals. Then confirm failure isolation:

- StopExecution or a one-sided Map failure leaves the workflow `FAILED` and
  does not publish a master playlist.
- A child whose `encoder` container `exitCode` is nonzero makes the execution
  `FAILED`; do not treat a `STOPPED` ECS task alone as success.
- Residual encoder tasks after failure or StopExecution are inspected with the
  query above and cleaned up within the parent `deadline_at` window.
