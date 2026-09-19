# Distributed encoding operations

The coordinator starts one fixed Fargate encoder per requested `360p` or `720p`
rendition. A failed or timed-out Step Functions execution does not prove that
every ECS child has stopped; optimized `ecs:runTask.sync` completion and
execution cancellation are best-effort observations.

StartExecution uses the deterministic name `job-{job_id}-a{attempt}` and the
same parent input. A lost start response is resolved by describing that name
and attaching only when the stored input is identical. Do not mint a new
execution name when the existing execution has conflicting input or has already
failed. Step Functions `SUCCEEDED` is not job completion: the parent still has
to finalize child objects and commit under the current owner before
acknowledgement.

For a failed execution, record only the execution ARN, job/attempt, rendition,
task ARN, and stop reason. Do not print the complete task JSON: container
overrides can contain `CHILD_PAYLOAD_JSON`.

The coordinator confirms residual children from ECS live state, not from Step
Functions history event counts. For every prior attempt `1..current_attempt` it
reads launched task ARNs from `GetExecutionHistory`, then `DescribeTasks`.
`lastStatus` `STOPPED` (including `MISSING` tasks already garbage-collected) is
not residual; `RUNNING`, `PENDING`, and any other non-`STOPPED` status is
residual. Residual tasks receive `StopTask`, then the coordinator re-describes
within the parent `deadline_at` window. Residual running children across those
executions plus the new renditions must still fit the two-encoder-per-parent
cap. If any prior execution cannot be inspected, or the combined bound cannot
be established before the deadline, it does not start a new execution and
returns to the existing retry policy.

A single `DescribeExecution` `NotFound` is not treated as "no execution": the
coordinator retries with backoff a bounded number of times before concluding
the execution does not exist. A `FAILED` or `TIMED_OUT` execution is not proof
that its children stopped. Operator inspection uses the same ECS query; never
delete completed-job objects or objects belonging to another attempt.

```bash
aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --output json
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --output json \
  --query 'tasks[].{taskArn:taskArn,lastStatus:lastStatus,desiredStatus:desiredStatus,stopCode:stopCode,stoppedReason:stoppedReason,startedAt:startedAt,stoppedAt:stoppedAt,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,reason:reason}}'
```

## Live acceptance

In a dedicated environment, start one two-rendition payload and confirm the
execution history shows two distinct encoder task ARNs with overlapping running
intervals. Then confirm failure isolation:

- StopExecution leaves the workflow `ABORTED` and does not publish a master
  playlist. A one-sided Map failure leaves the workflow `FAILED` and does not
  publish a master playlist.
- A child whose `encoder` container `exitCode` is nonzero makes the execution
  `FAILED`; do not treat a `STOPPED` ECS task alone as success.
- Residual encoder tasks after failure or StopExecution are confirmed with
  `DescribeTasks` (`lastStatus`) and cleaned up with `StopTask` within the
  parent `deadline_at` window. History event counts are not sufficient.
