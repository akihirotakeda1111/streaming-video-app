# Reliability E2E runner

`python app/scripts/run_reliability_e2e.py --check` is offline only. It checks
for `node`, `npm`, `npx`, `ffmpeg`, and `aws`, then invokes the local Node validator
with a 10-second deadline. It does not contact AWS, databases, queues,
browsers, containers, or services, create evidence directories, or run scenarios.
Missing live settings are reported as `not configured` and return zero when
local tools are available. Malformed supplied settings or missing tools return
2. Complete settings are reported as `configured; live resources not verified`.

The Python runner and direct Playwright reliability authorization use the same
`safety.mjs` validator. Configuration parsing is separate from live authorization;
`loadReliabilityConfig()` alone does not authorize scenario operations.

Live configuration requires all of the following:

- `E2E_ENVIRONMENT=disposable` and `E2E_RELIABILITY_DISPOSABLE=true`.
- `E2E_FRONTEND_URL` and `E2E_API_URL`: HTTP(S), without credentials, query, or fragment.
- Non-secret identities: `E2E_SOURCE_QUEUE`, `E2E_DLQ`, `E2E_SOURCE_BUCKET`,
  `E2E_OUTPUT_BUCKET`, `E2E_WORKER_OBSERVATION`, `E2E_DATABASE_OBSERVATION`,
  `E2E_WORKER_PROCESS_CONTROL`, and `E2E_DATABASE_PROCESS_CONTROL`.
- `E2E_SOURCE_DLQ` matching `E2E_DLQ`, and
  `E2E_SOURCE_DLQ_RELATIONSHIP=verified`. These are declarations, not evidence
  of an actual source-queue redrive policy. `configured` is allowed offline
  but is reported as incomplete for live execution.
- `E2E_MAX_ATTEMPTS`: an integer from 1 through 10; and
  `E2E_ALARM_IDENTIFIERS`: a nonempty comma-separated list of identities.
- Explicit integer millisecond values from 1 through 900000 for each of
  `E2E_NAVIGATION_TIMEOUT_MS`, `E2E_UPLOAD_TIMEOUT_MS`,
  `E2E_PROCESSING_TIMEOUT_MS`, `E2E_LEASE_TIMEOUT_MS`,
  `E2E_VISIBILITY_TIMEOUT_MS`, `E2E_DLQ_TIMEOUT_MS`, and `E2E_PLAYBACK_TIMEOUT_MS`.
  Phase 1 browser tests retain their existing defaults.
- `E2E_WORKER_CONTROL_SCOPE` and `E2E_DATABASE_CONTROL_SCOPE` identifying
  test-owned process/service boundaries. Wildcards and `all`, `host`, `shared`,
  or `production` are rejected even offline. A name alone does not prove ownership.
- An absolute `E2E_EVIDENCE_DIR` without parent traversal.

## Live preflight and supported adapter

The supported disposable adapter uses the AWS CLI for bounded read-only STS,
S3, SQS, and CloudWatch observations. It compares the source queue's actual
redrive target ARN with the actual DLQ ARN. It also supports exact local process
boundaries written as `process:<executable>` for worker and database observation
and control; the named process must be present, and control names must match the
observed names. No process is stopped or restarted during preflight.

Required additional target settings are `AWS_REGION` and the expected
12-digit `E2E_AWS_ACCOUNT_ID`; AWS credentials are supplied through the normal
AWS CLI credential provider and are never printed. The CLI must have permission
for `sts:GetCallerIdentity`, `s3:HeadBucket`, `s3:GetBucketLocation`,
`sqs:GetQueueUrl`, `sqs:GetQueueAttributes`, and
`cloudwatch:DescribeAlarms`. Missing permissions, unavailable tools, identity
mismatches, unsupported process boundaries, and bounded observation failures
block before any scenario operation.

Run the standalone verification with:

`python app/scripts/run_reliability_e2e.py --live-preflight`

On success it prints redacted verification evidence and writes
`<E2E_EVIDENCE_DIR>/live-preflight.json`. This command creates no jobs, queue
messages, objects, database records, worker changes, or failure injections.
The Python runner and direct Playwright reliability execution call this same
shared verification boundary before dispatch or scenario work.
The standalone Phase 1 `@preflight` browser readiness test retains its existing scope.

`--list` shows the implemented selectors: `preflight` (local/browser/API readiness)
and `runtime-authorization` (reliability authorization). Unknown selectors fail.
Failure scenarios remain outside this task; their successor specs provide their
selectors and adapters.
Every future reliability scenario
must call that authorization before any operation, even when selected directly;
a separate authorization test does not establish ordering for other tests.

Once authorized dispatch is supported, the runner creates a unique child directory
under `E2E_EVIDENCE_DIR` and passes its name as `E2E_RUN_ID`. Diagnostics must use
existing redaction helpers and exclude credentials, receipt handles, database URLs,
and full presigned URLs. Worker/database controls must exclude unrelated processes
and restore the prior test-owned state when safe. Cleanup is limited to canonical
resources registered by the current run through `RunResources`. The runner does
not edit source, Compose, IAM, networking, Terraform, or queues to enable a run.

## Offline regression checks

`npm --prefix app/frontend run test:e2e:helpers` includes shared-policy and Python
entry-point tests. Python must be on PATH, or `PYTHON` may name its executable.
Tests use disposable dummy identities, fake local-tool availability, and a process
boundary allowing only the local validator; no live adapter or scenario is called.
They cover missing settings, malformed scopes, completeness, redaction, validator
timeouts, and refusal to dispatch without supported adapters.

Human verification against the intended disposable environment remains
outstanding until the command above succeeds and its redacted evidence is
retained. Offline tests and type checks do not replace that evidence.
