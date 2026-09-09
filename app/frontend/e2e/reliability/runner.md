# Reliability E2E runner

環境変数を既存AWS/Docker設定から生成する場合は
[環境変数設定コマンドの生成](environment-generator.md) を参照。
生成スクリプトはこの共通事前確認の要件を変更せず、非機密の設定コマンドだけを出力する。

`python app/scripts/run_reliability_e2e.py --check` is offline only. It checks
for `node`, `npm`, `npx`, `ffmpeg`, `aws`, and `docker`, then invokes the local Node validator
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

The supported adapter uses the AWS CLI and a direct local Docker Engine hosting
Linux containers. It reads STS, S3, SQS and CloudWatch metadata, plus Docker info
and container inspection. It never starts, stops or restarts anything.

Required additional settings:

- `AWS_REGION` and the expected 12-digit `E2E_AWS_ACCOUNT_ID`.
- `E2E_DOCKER_HOST`: a direct local socket, for example
  `unix:///var/run/docker.sock` on Linux or
  `npipe:////./pipe/docker_engine` on Docker Desktop. Remote endpoints and
  authorization-plugin deployments are unsupported and fail closed. The local
  socket must connect directly to a trusted Engine, not a filtering proxy.
- Worker and database observation/control identifiers both use
  `docker:<full 64-character container ID>`. Names, abbreviated IDs and
  `process:<name>` are unsupported. Obtain the IDs with
  `docker container inspect --format '{{.Id}}' <test-owned-container>`.
- Both containers must already have the labels
  `com.streaming-video.e2e.disposable=true`,
  `com.streaming-video.e2e.scope=<corresponding E2E control scope>`, and
  `com.streaming-video.e2e.role=worker` or `database`.
  These labels are inspected on actual immutable container IDs. The environment
  owner must assign them only to dedicated disposable resources, including their
  database storage. Merely setting the E2E environment variables is insufficient.
  Do not label or reuse shared deployments to make this check pass.
- Containers must be running, unpaused, non-privileged, outside the host PID
  namespace, with automatic removal disabled. The Worker must directly run the
  repository image entrypoint `/usr/local/bin/video-worker`, with no wrapper or
  extra arguments. PostgreSQL must use `docker-entrypoint.sh postgres`.
- The Worker container must explicitly contain all five `WORKER_*` reliability
  variables, `AWS_REGION`, `VIDEO_ENCODING_QUEUE_URL`, `VIDEO_INPUT_BUCKET`,
  `VIDEO_OUTPUT_BUCKET`, and `DATABASE_URL`. The repository Worker has no defaults
  for these fields; Compose resolves its defaults before container creation.
  A direct Worker entrypoint makes its container environment the startup settings.
  The database host must resolve through a shared Docker network to the inspected
  PostgreSQL container's address or alias, using its standard port 5432.
- PostgreSQL must have a passing healthcheck. All attached volumes must be local
  named Docker volumes with no driver options, labeled disposable and with the
  corresponding scope just like their container. Volume inspection and the list
  of all attached containers must show that only the selected container uses each
  volume. Bind mounts, remote volumes and shared storage are unsupported.

The existing Compose file is not changed or provisioned by the runner. A human
must prepare the dedicated labeled environment and verify Phase 2 Terraform
before live acceptance. An unlabeled existing Compose deployment is blocked.

Docker control capability is established through direct Engine access and the
absence of authorization plugins: Docker's default authorization is all-or-nothing.
The evidence binds control to the full ID, start time and Engine ID. Future
failure scenarios must reverify this identity immediately before control, stop
only that container with a bounded deadline, retain it, and restore by starting
the same container. Never remove/recreate it, stop a Compose project, select by
process name, or operate on unrelated containers. Preflight does not perform a
stop/start probe or prove that a later restart will succeed.

Timing values in `E2E_*_TIMEOUT_MS` are observation budgets. SQS seconds are
converted to milliseconds. Queue visibility and Worker visibility extension must
fit `E2E_VISIBILITY_TIMEOUT_MS`; Worker lease duration must fit
`E2E_LEASE_TIMEOUT_MS`; retry delay must fit `E2E_DLQ_TIMEOUT_MS`. Equality is
accepted; allow extra polling margin for live runs. For example, queue visibility
180 seconds fits a 180000 ms visibility budget. The Worker heartbeat must leave
at least one heartbeat interval of safety margin before both visibility and lease
expire. Retry, lease and extension must be positive and at most 43200 seconds;
Worker attempts, queue maxReceiveCount and E2E_MAX_ATTEMPTS must agree (1–10).
The DLQ budget check covers one retry delay, not the entire sequence of receives;
scenario-specific total wait budgets still need to cover the selected scenario.

`E2E_ALARM_IDENTIFIERS` must list three distinct alarm names. Their observed
AWS/SQS metric and QueueName dimension must cover source oldest-message age,
source visible count and DLQ visible count exactly once. Bucket observations use
`--expected-bucket-owner` as well as checking region; queue URLs and ARNs must
match the expected account and region.

AWS credentials use the normal CLI provider and are never printed. Required
read operations are STS GetCallerIdentity, S3 HeadBucket/GetBucketLocation, SQS
GetQueueUrl/GetQueueAttributes, and CloudWatch DescribeAlarms. For general-purpose
S3 buckets the IAM actions are `s3:ListBucket` and `s3:GetBucketLocation`
(`s3:HeadBucket` is not an IAM action). Docker inspect responses and database URLs
stay in memory and are excluded from evidence and failure messages.

Every observation is limited to 10 seconds and the common live verification has
a 120-second total deadline. Python allows 130 seconds for the live subprocess,
including startup/serialization, while offline validation retains its 10-second
limit. Permission failures, malformed responses and unsupported capabilities
block before scenario dispatch.

Run the standalone verification with:

`python app/scripts/run_reliability_e2e.py --live-preflight`

On success it prints redacted verification evidence and writes
`<E2E_EVIDENCE_DIR>/preflight-<UUID>/live-preflight.json`. This command creates no jobs, queue
messages, objects, database records, worker changes, or failure injections.
The Python runner and direct Playwright reliability execution call this same
shared verification boundary before dispatch or scenario work.
The standalone Phase 1 `@preflight` browser readiness test retains its existing scope.

`--list` shows the implemented selectors: `preflight` (local/browser/API readiness),
`runtime-authorization` (reliability authorization), and `duplicate-delivery`
(active and completed redelivery). Select it with:

`python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery`

The runner dispatches this selector only to Playwright's `reliability` project
with the exact `@duplicate-delivery` tag through the installed Node/Playwright CLI.
Unknown selectors fail. The Python entry point does not require a POSIX shell.

The duplicate scenario verifies the Worker observation capability before creating
canonical test rows and uploading an MP4. It injects an active duplicate and a
post-completion duplicate, correlates each message's outcomes through delivery
spans, and proves one effective encode/publication plus immutable completion.
The supported adapter and [duplicate execution guide](duplicate-runbook.md) define
fixture requirements, existing permissions, exact run cleanup and retained-resource
failure handling. Missing observations, too-short workloads and unsafe cleanup
remain unverified failures, never skipped/passed checks. Human live evidence is
still required for acceptance.

Every future reliability scenario
must call that authorization before any operation, even when selected directly;
a separate authorization test does not establish ordering for other tests.

After authorization, the runner creates a unique child directory
under `E2E_EVIDENCE_DIR` and passes its name as `E2E_RUN_ID`. Diagnostics must use
existing redaction helpers and exclude credentials, receipt handles, database URLs,
and full presigned URLs. Worker/database controls must exclude unrelated processes
and restore the prior test-owned state when safe. Cleanup is limited to canonical
resources registered by the current run. The runner does
not edit source, Compose, IAM, networking, Terraform, or queues to enable a run.

## Offline regression checks

`npm --prefix app/frontend run test:e2e:helpers` includes shared-policy and Python
entry-point tests. Python must be on PATH, or `PYTHON` may name its executable.
Tests use disposable dummy identities and fake external command responses while
executing the real authorization policy. No external services are contacted.
They cover missing settings, malformed scopes, completeness, redaction, validator
timeouts, refusal to dispatch without supported adapters, dedicated duplicate
selector/tag/project dispatch, and nonzero exit propagation. The duplicate entry
point is checked for authorization failure, successful scenario dispatch and
retained-resource failures. Driver/adapter tests exercise duplicate side effects,
wrong acknowledgements, completion overwrites, pending messages and ambiguous
transport outcomes without invoking live services.

Human verification against the intended disposable environment remains
outstanding until the command above succeeds and its redacted evidence is
retained. Offline tests and type checks do not replace that evidence.

Evidence roots may already exist; each preflight gets a unique child directory,
so repeated checks retain previous evidence. A local evidence-write failure is
reported with a fixed redacted message. Successful offline tests are not live
acceptance. The PR must retain the outstanding human preflight requirement until
an actual successful evidence file has been reviewed.

Adapter references: [Docker inspect](https://docs.docker.com/reference/cli/docker/container/inspect/),
[Docker authorization](https://docs.docker.com/engine/extend/plugins_authorization/),
and [S3 HeadBucket](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-bucket.html).
