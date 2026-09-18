# Distributed encoding operations

The coordinator starts one fixed Fargate encoder per requested `360p` or `720p`
rendition. A failed or timed-out Step Functions execution does not prove that
every ECS child has stopped; optimized `ecs:runTask.sync` completion and
execution cancellation are best-effort observations.

For a failed execution, record only the execution ARN, job/attempt, rendition,
task ARN, and stop reason. Inspect tasks launched by that execution in the
dedicated environment before retrying the parent:

```bash
aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --output json
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --output json
```

Stop only confirmed residual encoder tasks from the failed execution, then
re-check `describe-tasks` until each reaches `STOPPED`. Bound this inspection
and cleanup window by the parent deadline; escalate tasks that remain running
after the window rather than assuming execution cancellation terminated them.
Never delete completed-job objects or objects belonging to another attempt.
