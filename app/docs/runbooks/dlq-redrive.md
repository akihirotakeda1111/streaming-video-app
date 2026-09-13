# DLQ observation and redrive runbook

This runbook covers read-only DLQ inspection and narrowly authorized manual
recovery in a disposable Phase 2 E2E environment. The contract is
[`reliability-conventions.md`](../../contracts/domain/reliability-conventions.md);
the checked-in executable matrix is
[`component-matrix.md`](../../frontend/e2e/reliability/component-matrix.md).

## Safe observation

First confirm a unique run ID, exact source queue/DLQ identity, disposable
opt-in, matching account and region, and no unrelated consumer. The observation
phase of queue-monitoring performs only `sqs:get-queue-attributes`,
`cloudwatch:get-metric-data`, and `cloudwatch:describe-alarms`. It records
source/DLQ approximate visible count, oldest-message age, and the three
validated SQS alarm states/reasons (`OK`, `ALARM`, or `INSUFFICIENT_DATA`).

The complete command also runs the shared live-boundary authorization before
observation. Prepare these AWS reads for the configured disposable resources:

| Phase / API operation | IAM permission or condition |
| --- | --- |
| Authorization: STS `GetCallerIdentity` | Valid AWS credentials and STS access; no explicit IAM allow is required for this operation |
| Authorization: SQS `GetQueueUrl` | `sqs:GetQueueUrl`, when a queue is configured by name rather than URL |
| Authorization and observation: SQS `GetQueueAttributes` | `sqs:GetQueueAttributes` on source queue and DLQ |
| Authorization: S3 `HeadBucket` | `s3:ListBucket` on source and output buckets |
| Authorization: S3 `GetBucketLocation` | `s3:GetBucketLocation` on both buckets |
| Authorization and observation: CloudWatch `DescribeAlarms` | `cloudwatch:DescribeAlarms` |
| Observation: CloudWatch `GetMetricData` | `cloudwatch:GetMetricData` |

Authorization also checks the local Docker worker/database boundary. Follow
[`runner.md`](../../frontend/e2e/reliability/runner.md) for the shared tools,
settings, and local access prerequisites. Queue monitoring needs no fixture;
its complete success requires the earlier FFmpeg and poison evidence below.

Offline check:

```text
python app/scripts/run_reliability_e2e.py --check
```

Live boundary check:

```text
python app/scripts/run_reliability_e2e.py --live-preflight
```

Read-only monitoring, with no replay or deletion:

```text
python app/scripts/run_reliability_e2e.py --scenario queue-monitoring \
  --ffmpeg-evidence-run e2e-<FFMPEG-UUIDv4> \
  --poison-evidence-run e2e-<POISON-UUIDv4>
```

Keep `E2E_EVIDENCE_DIR` set to the same parent used by both referenced runs.
The monitoring scenario has a 300000 ms observation bound; generated visibility,
lease, and DLQ bounds remain capped at 900000 ms. A timeout, missing alarm,
metric delay, identity mismatch, or non-empty `outstanding` list is not a pass.

The human observer may independently inspect the same allow-listed data with
non-secret placeholders, for example:

```text
aws sqs get-queue-attributes --queue-url '<SOURCE_QUEUE_URL>' \
  --attribute-names ApproximateNumberOfMessages --region '<REGION>' --output json
aws cloudwatch describe-alarms --alarm-names '<ALARM_AGE>' '<ALARM_BACKLOG>' '<ALARM_DLQ>' \
  --region '<REGION>' --output json
```

Do not paste real URLs, query strings, credentials, or receipt handles into
logs or evidence. The queue-monitoring harness derives and validates queue
identities from the disposable boundary and redacts diagnostics.

## Visibility side effect of inspection

Reading a DLQ message is not read-only with respect to queue state. The
implemented poison/failed-job correlation uses `ReceiveMessage`; receiving
makes those messages temporarily invisible and can change their delivery
visibility timing. It must therefore be done only by the gated disposable
scenario, for run-owned messages, with its bounded receive operation. Do not
use `ReceiveMessage` as a casual status check, and do not expose its receipt
handle. Never call `DeleteMessage`, `PurgeQueue`, or a replay operation during
metric/alarm inspection.

For poison isolation, the configured bound is `A * VISIBILITY + DLQ`; the
dedicated defaults are `3 * 150s + 40s = 490s`. For FFmpeg exhaustion, use
`PROCESSING + (A - 1) * retry + VISIBILITY + DLQ`, then one visibility-sized
post-DLQ confirmation. `ApproximateReceiveCount` is a queue receive count, not
the database `attempt` field.

## Manual replay decision

Replay is not an automatic repair. It requires explicit human intent and all
of these checks:

- exact disposable account, region, source queue, DLQ, run ID, and canonical
  message/job identity;
- root cause fixed and no active database lease owner (`lease_expires_at` is
  checked against `CURRENT_TIMESTAMP`);
- an eligible `UPLOADING`, `QUEUED`, or recoverable `PROCESSING` state with
  remaining attempt budget, as defined by the contract;
- a documented plan for one message only and run-scoped cleanup.

`COMPLETED` is immutable and must not be re-encoded. A terminal `FAILED` job or
an exhausted crashed job cannot become retryable by replay alone. If replay
would need a state/attempt reset, unsupported queue operation, database edit,
bulk replay, bulk purge, or any repair mechanism outside the contract, stop and
escalate to the service owner. Do not invent SQL updates or manually fabricate
terminal outcomes.

## Evidence, cleanup, and escalation

Retain the redacted scenario JSON, run ID, UTC observation times, queue/alarm
observations, correlation result, and cleanup result. Evidence lives in the
configured `E2E_EVIDENCE_DIR` parent, in generated child directories; the
expected files are `queue-monitoring-evidence.json`,
`ffmpeg-exhaustion-evidence.json`, `poison-isolation-evidence.json`, and the
referenced `full-suite-*.json` report.

Cleanup is limited to resources and canonical IDs created by the current run.
Do not purge either queue, delete unrelated DLQ messages, or automatically
replay anything. Uncertain ownership, unavailable safe controls, unexpected
terminal state, contract conflict, or an exceeded bound requires retaining
redacted evidence and human escalation.

## Final Phase 1 and MVP verification

Human Terraform verification precedes the live run. Prepare all full-suite
prerequisites in [`runner.md`](../../frontend/e2e/reliability/runner.md),
including both fixtures and Chromium. Set `E2E_PROJECT=chromium` so browser
preflight matches the final playback, then run each command separately and
continue only after it succeeds:

```text
python app/scripts/run_reliability_e2e.py --check
python app/scripts/run_reliability_e2e.py --live-preflight
python app/scripts/run_reliability_e2e.py --scenario preflight
python app/scripts/run_reliability_e2e.py --full
```

`--live-preflight` verifies the disposable resource boundary and must report
`status=verified`. `--scenario preflight` checks Frontend, API, browser, and
host FFmpeg readiness. `--full` does not run that browser preflight itself.

The full suite runs duplicate delivery, crash recovery, long heartbeat, FFmpeg
exhaustion, poison isolation, and queue monitoring, then the fresh Chromium
`@phase1-pipeline` playback regression. The final playback must show direct
upload, API `COMPLETED`, segments before `index.m3u8`, HLS object and
network/CORS checks, and positive media-time advancement. Retain the full
report and all referenced child evidence. Human Terraform verification and
successful complete live evidence are both required for MVP sign-off;
offline success alone is insufficient. If the live run has not occurred or is
incomplete, report it as outstanding.
