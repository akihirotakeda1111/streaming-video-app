# Worker runtime handoff

## Fargate deployment

The compute root builds no image automatically. For the first deployment, create
the worker ECR repository before pushing an image. Configure the compute variables
as described in [cloud-runtime.md](cloud-runtime.md), leave `worker_image_digest`
unset, and set `worker_desired_count = 0` until the database secret and migrations
are ready. From the repository root, in Bash with `AWS_REGION` set:

```bash
terraform -chdir=app/infra/terraform-compute init
terraform -chdir=app/infra/terraform-compute plan -target=aws_ecr_repository.worker -out=worker-bootstrap.tfplan
terraform -chdir=app/infra/terraform-compute apply worker-bootstrap.tfplan
WORKER_REPOSITORY=$(terraform -chdir=app/infra/terraform-compute output -raw worker_repository_url)
WORKER_REGISTRY=${WORKER_REPOSITORY%%/*}
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$WORKER_REGISTRY"
# Choose a new tag for every build; tags are immutable.
WORKER_IMAGE_TAG=worker-001
docker build --platform linux/amd64 -f app/backend/worker/Dockerfile -t "$WORKER_REPOSITORY:$WORKER_IMAGE_TAG" app/backend/worker
docker push "$WORKER_REPOSITORY:$WORKER_IMAGE_TAG"
aws ecr describe-images --repository-name "${WORKER_REPOSITORY#*/}" \
  --image-ids imageTag="$WORKER_IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text
```

Persist the returned immutable `sha256:` digest as `worker_image_digest` in
`terraform.tfvars`. Full apply also requires a pushed API image and
`api_image_digest`, even when the API desired count is zero. Targeting is only for
initial repository creation; after both digests are set, review and apply the full plan:

```bash
terraform -chdir=app/infra/terraform-compute plan -out=worker.tfplan
terraform -chdir=app/infra/terraform-compute apply worker.tfplan
```

For a new environment, keep both desired counts at zero and complete the secret
and migration steps in [cloud-runtime.md](cloud-runtime.md). Once ready, persist
`worker_desired_count = 1`, then review and apply a fresh full plan. The service
uses one receive slot per task. Confirm ECS stability, database connectivity and
task protection before stopping the local worker. Temporarily set
`worker_desired_count = 2` and apply a full plan to verify distinct jobs run
concurrently. The database lease remains authoritative while the old local worker
and ECS revisions overlap.

The worker has no ALB target or inbound port. Its task role is limited to the
encoding queue, canonical input reads, HLS output writes, and ECS task protection
on `arn:aws:ecs:<region>:<account>:task/<cluster-name>/*`;
its execution role separately reads the application database secret and writes
CloudWatch logs. `DATABASE_URL` must contain explicit `sslmode=verify-full` (the
container downloads the AWS RDS CA bundle at build time to
`/app/certs/rds-global-bundle.pem`, matching API and migration).
Terraform sets `DATABASE_CA_CERT_PATH` to that file, which is readable by the
unprivileged Worker user. Download failure or an empty bundle fails the build.
Rebuild and deploy a new image digest when the RDS CA bundle changes.

`worker_desired_count` accepts only integers from 0 through 4. The example keeps
it at zero for bootstrap; raise it to one only after migration succeeds.

The deployment reserves 50 GiB of ephemeral storage, 1024 CPU units, 2048 MiB,
and a 30-second stop timeout. The timeout exceeds the five-second runtime grace
period plus protection-request and cleanup margin. Diagnose failures in order:
ECR digest/image pull, task execution-role logs/secret access, database TLS and
security-group connectivity, task-role SQS/S3 access, ECS protection acquire/
renew/release, then ephemeral-disk limits. Confirm protection transitions in ECS
task details before changing desired count; autoscaling policy and metrics belong
to the later scaling task.

Task 10 implements the application runtime. Tasks 11–13 own infrastructure,
IAM, deployment resource allocation, and scaling policies.

## Live acceptance: startup, processing, protection, and recovery

Run these checks in a dedicated test environment/queue after image bootstrap,
secret setup, and successful migration. Use Bash with AWS CLI, Terraform and jq,
with `AWS_REGION` and the intended operator credentials configured. Stop the local
Worker for these checks so it cannot consume the test jobs. Use MP4 files within
the configured source/duration limits, long enough to observe processing.
Use the normal application upload flow so the video/job rows exist before the
S3 notification arrives. Keep the job IDs, timestamps, task ARNs and log streams
as evidence; do not record database credentials or presigned upload URLs.

### 1. Confirm one ECS Worker starts

Persist `worker_desired_count = 1` in `terraform.tfvars`, then review and apply:

```bash
terraform -chdir=app/infra/terraform-compute plan -out=worker-start.tfplan
terraform -chdir=app/infra/terraform-compute apply worker-start.tfplan
CLUSTER=$(terraform -chdir=app/infra/terraform-compute output -raw ecs_cluster)
SERVICE=$(terraform -chdir=app/infra/terraform-compute output -raw worker_service)
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
SERVICE_STATE=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
jq -e '(.failures | length) == 0 and (.services | length) == 1 and
  .services[0].desiredCount == 1 and .services[0].runningCount == 1 and
  .services[0].pendingCount == 0' <<< "$SERVICE_STATE"
TASK=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --query 'taskArns[0]' --output text)
TASK_DEFINITION=$(jq -r '.services[0].taskDefinition' <<< "$SERVICE_STATE")
LOG_GROUP=$(aws ecs describe-task-definition --task-definition "$TASK_DEFINITION" \
  --query 'taskDefinition.containerDefinitions[?name==`worker`].logConfiguration.options."awslogs-group" | [0]' --output text)
aws logs tail "$LOG_GROUP" --since 10m --follow
```

Require `desired=1 / running=1 / pending=0` and `worker started` in the current
task's `worker/worker/<task-id>` log stream. Check for DB/TLS, SQS, S3 initialization
or subsequent request errors and repeated task restarts. Startup alone does not
prove SQS/S3 permissions; confirm real processing below. Stop the log tail with
Ctrl-C before continuing, or keep it running in another terminal. On waiter or
count-check failure, inspect service events and stopped-task reasons before proceeding.

### 2. Confirm normal processing with one Worker

Upload one MP4 through the application and record its `VIDEO_ID` and `JOB_ID`.
Watch application/API status and logs for `QUEUED -> PROCESSING -> COMPLETED`.
The short `QUEUED` phase may be missed by polling; correlate the recorded
transitions with logs rather than treating one final snapshot as evidence.

Connect to the application database through the in-VPC, verified-TLS procedure
in [cloud-runtime.md](cloud-runtime.md#3-create-the-application-role-through-an-in-vpc-ssm-host).
In psql, substitute the actual job UUID and observe before, during and after encoding:

```sql
\set job_id 'REPLACE_WITH_JOB_UUID'
SELECT clock_timestamp() AS observed_at, id, video_id, status, attempt,
       worker_id, lease_expires_at,
       (worker_id IS NOT NULL AND lease_expires_at > CURRENT_TIMESTAMP) AS valid_owner
FROM jobs WHERE id = :'job_id'::uuid;
\watch 1
```

Use autocommit, not a long-running transaction. During `PROCESSING`, require a
non-NULL `worker_id`, a future `lease_expires_at`, and lease renewal while the job
continues. After `COMPLETED`, both fields must be NULL. Correlate `worker_id`,
`job_id` and `attempt` with `record outcome` logs in that task's log stream.
Stop `\watch` with Ctrl-C.

```bash
VIDEO_ID=REPLACE_WITH_VIDEO_UUID
JOB_ID=REPLACE_WITH_JOB_UUID
OUTPUT_BUCKET=$(terraform -chdir=app/infra/terraform output -raw video_output_bucket_name)
aws s3 ls "s3://$OUTPUT_BUCKET/videos/$VIDEO_ID/jobs/$JOB_ID/hls/" --recursive
```

Require the HLS manifest and referenced segments, then play the completed video
through the application's CloudFront playback URL. Object presence alone is not
a playback check. If the shared root is elsewhere, use that root for its outputs.

### 3. Confirm Task Protection during and after processing

While the job is still processing, refresh the service's current Worker task ARN
immediately before checking protection. Do not reuse the ARN from step 1: the
task may have restarted. This step expects exactly one running Worker; if the
checks fail, inspect service stability and retry rather than selecting an
arbitrary task. Correlate the refreshed ARN's log stream with the job's current
owner before interpreting the protection result.

```bash
TASKS=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --output json) || exit 1
TASK=$(jq -er '.taskArns | select(length == 1) | .[0]' <<< "$TASKS") || exit 1
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --output json \
  | jq -e '(.failures | length) == 0 and (.tasks | length) == 1 and
    .tasks[0].lastStatus == "RUNNING"' || exit 1
PROTECTION=$(aws ecs get-task-protection --cluster "$CLUSTER" --tasks "$TASK" --output json)
jq -e --arg task "$TASK" '(.failures | length) == 0 and
  any(.protectedTasks[]; .taskArn == $task and .protectionEnabled == true)' <<< "$PROTECTION"
jq '.protectedTasks[] | {taskArn, protectionEnabled, expirationDate}' <<< "$PROTECTION"
```

Require `protectionEnabled=true` and a future expiration. For a long job, repeat
the query and confirm expiration is renewed. After completion, stop submitting
work and observe the idle release window:

```bash
for observation in {1..45}; do
  date -u +%FT%TZ
  aws ecs get-task-protection --cluster "$CLUSTER" --tasks "$TASK" --output json
  sleep 2
done
```

Confirm a successful response with `protectionEnabled=false`. Release occurs
after an empty receive with no active work or pending receive, not necessarily
at the instant the job completes. The Worker releases for ten seconds and then
reacquires before polling, so a later `true` value is expected. Correlate this
with completion/idle timing and protection errors in CloudWatch. The current
runtime does not emit a dedicated successful acquire/release log; use ECS/API
state as the evidence, not absence of errors. A response with `failures` is not
proof of release. See [get-task-protection](https://docs.aws.amazon.com/cli/latest/reference/ecs/get-task-protection.html).

### 4. Confirm parallel work and duplicate-delivery ownership with two Workers

Persist `worker_desired_count = 2`, then review and apply a fresh full plan:

```bash
terraform -chdir=app/infra/terraform-compute plan -out=worker-two.tfplan
terraform -chdir=app/infra/terraform-compute apply worker-two.tfplan
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json \
  | jq -e '(.failures | length) == 0 and (.services | length) == 1 and
    .services[0].desiredCount == 2 and .services[0].runningCount == 2 and
    .services[0].pendingCount == 0'
aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --output json
```

Upload two MP4s almost simultaneously. Query both job rows with
`WHERE id IN ('<job-1-uuid>'::uuid, '<job-2-uuid>'::uuid)` using the columns above.
Require overlapping `PROCESSING` observations with two different `worker_id`
values and unexpired leases. Match each to `outcome="acquired"` in a different
task log stream, and require both jobs to complete and play successfully.

For duplicate delivery, start a fresh sufficiently long job and leave the second
Worker free. While the first holds a valid lease, send a synthetic S3 event
for the same existing object/job into the dedicated test queue. The payload below
is a minimal notification payload accepted by the current Worker parser, not a
complete reproduction of an actual S3 notification. It exercises duplicate-job
handling through SQS; it does not verify the full S3 notification format or the
S3-to-SQS delivery path. Revisit this payload if parser requirements change. Set `VIDEO_ID`
and `JOB_ID` to this fresh job. The operator needs `sqs:SendMessage`; do not grant
that permission to the Worker role or overwrite the source object.

```bash
INPUT_BUCKET=$(terraform -chdir=app/infra/terraform output -raw video_input_bucket_name)
QUEUE_URL=$(terraform -chdir=app/infra/terraform output -raw video_encoding_queue_url)
DUPLICATE_EVENT=$(jq -nc --arg bucket "$INPUT_BUCKET" \
  --arg key "videos/$VIDEO_ID/jobs/$JOB_ID/source.mp4" \
  '{Records:[{eventSource:"aws:s3",eventName:"ObjectCreated:Put",
    s3:{bucket:{name:$bucket},object:{key:$key}}}]}')
aws sqs send-message --queue-url "$QUEUE_URL" --message-body "$DUPLICATE_EVENT"
```

Require the other Worker to log `outcome="busy"` for this job while the original
lease remains valid; its duplicate must not acquire ownership or increment the
attempt. Observe a stable owner in DB, renewed lease, and no overlapping
`acquired` outcomes for different owners. A single DB row/snapshot alone cannot
prove absence of competing work: retain the timed DB observations and both task
logs. After completion, any duplicate redelivery should log `already_completed`
without re-encoding or changing `COMPLETED`. If the duplicate is received only
after completion, the overlap check is inconclusive; repeat with a longer job.

### 5. Confirm recovery after StopTask

After the two-Worker checks finish, persist `worker_desired_count = 1`, apply a
fresh full plan, and repeat the step 1 stability/count check. This makes the
replacement task the only candidate to recover the job. Idle protection may
delay scale-in until its release window.

Upload a new long MP4, with attempt budget remaining. While it is `PROCESSING`,
record the job's owner, attempt, lease expiry, and owning task ARN from the log
stream. Set `TASK` to that exact active task and confirm the job has not completed.
Then stop it once:

```bash
STOPPED_TASK=$TASK
aws ecs stop-task --cluster "$CLUSTER" --task "$STOPPED_TASK" \
  --reason "Dedicated Worker recovery acceptance"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$STOPPED_TASK"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[].{desired:desiredCount,running:runningCount,pending:pendingCount}' --output table
TASK=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --query 'taskArns[0]' --output text)
test "$TASK" != "None" && test "$TASK" != "$STOPPED_TASK"
```

Require service counts `1 / 1 / 0`, a new task ARN and `worker started` in its log
stream. [StopTask](https://docs.aws.amazon.com/cli/latest/reference/ecs/stop-task.html)
sends SIGTERM before forced termination if needed; task scale-in protection does
not prevent this explicit stop. Inspect old-task shutdown logs and ECS stop reason.

Observe DB and logs until both the previous lease and SQS visibility have expired
and the replacement reacquires the same job. Use the configured heartbeat, lease
and visibility-extension values; do not assume immediate redelivery. Require a
new `worker_id`, a higher `attempt`, `outcome="acquired"` in the replacement's
stream, and eventual `COMPLETED` with both lease fields NULL. Verify HLS playback
again. Do not manually clear the lease, delete messages, or change visibility to
force this test to pass. If the job completed before shutdown took effect, repeat
with a longer input. If recovery fails, inspect expiry timing, attempt exhaustion,
DLQ, task events and DB/SQS/S3/protection errors, and record the failure rather
than treating replacement startup alone as successful recovery.

## Runtime configuration

All numeric settings are decimal positive integers; invalid values fail startup.

| Variable | Default | Range / meaning |
| --- | --- | --- |
| `WORKER_RUNTIME_MODE` | `ecs` | `local` or `ecs`; Compose explicitly sets `local` |
| `WORKER_MAX_CONCURRENCY` | `2` | 1–32 messages; empty uses default; Task 12 should initially set 1 |
| `ECS_AGENT_URI` | none | Required in ECS mode; ECS-injected HTTP agent URI; loopback supported for tests |
| `WORKER_MAX_SOURCE_BYTES` | 67108864 | 1–1073741824 bytes |
| `WORKER_MAX_TEMP_BYTES` | 536870912 | 1–17179869184 bytes per job, greater than source limit |
| `WORKER_DISK_RESERVE_BYTES` | 268435456 | 1–17179869184 bytes of disk headroom |
| `WORKER_FFMPEG_THREADS` | 1 | 1–16 decoder, encoder, and filter threads |
| `WORKER_MAX_DURATION_SECONDS` | 3600 | 1–14400 seconds of source media |
| `WORKER_MAX_WALL_SECONDS` | 7200 | 1–43200 seconds per pipeline, including waits and publication |
| `DATABASE_CA_CERT_PATH` | unset | Optional PEM CA bundle; empty/whitespace means unset |

Existing heartbeat, visibility, lease, retry, and maximum-attempt settings are
preserved. Database connections remain bounded at one per worker process,
shared by acquisition, heartbeat, and completion. Initial connection timeout
is ten seconds. Concurrency does not create additional database connections.

## Database TLS and credentials

Supply a shared `DATABASE_URL` with `sslmode=verify-full`. Go passes the URL to
pgx unchanged. Rust parses it and maps `verify-full` to the driver's `require`
mode with CA and hostname verification enabled. Rust also accepts `require`
with the same verification, but do not downgrade a shared Go URL to `require`.

Use `sslrootcert=/path/to/ca.pem` in the URL for a private CA in both drivers.
URL-encode paths as needed. The Worker optionally accepts
`DATABASE_CA_CERT_PATH`; a nonempty value overrides `sslrootcert`. The API does
not read that environment variable. With no custom path, Worker uses system
roots. PEM bundles can contain multiple certificates. Paths must exist inside
each container; an environment variable does not mount a certificate file.
Unreadable/malformed CAs, untrusted servers, hostname mismatches, and expired
server certificates fail without plaintext fallback.

Only explicit `WORKER_RUNTIME_MODE=local` plus `sslmode=disable` permits
plaintext. `prefer`, omitted mode, duplicate mode/CA parameters, and unsupported
modes are rejected. Compose retains its explicit local disable configuration.

S3/SQS use the SDK default credential chain, including task-role credentials.
Task protection uses the ECS agent, which uses the task role on behalf of the
worker. Task 12 supplies the role and appropriate `ecs:UpdateTaskProtection`
and `ecs:GetTaskProtection` permissions plus existing scoped S3/SQS access.
This task creates no IAM resources. Do not inject static cloud keys or log
credentials, database URLs, or tokens.

## Task protection and shutdown

ECS mode confirms protection before receiving, through PUT
`${ECS_AGENT_URI}/task-protection/v1/state` with two-minute expiry. The injected
URI's `/api/<id>` prefix is preserved (a trailing slash is handled without
duplicating the separator). HTTP success is insufficient:
the response must confirm the state and a future expiration. Each update has a
four-second overall bound. Renewal occurs at half the remaining lifetime while
receiving or processing, including when concurrency is full. Failure stops
new receives and cancels work. Local mode makes no agent calls.

After an empty receive with zero active tasks and no pending receive, protection
is released for ten seconds, then reacquired before polling. Completion during
an outstanding receive never releases protection or cancels that receive.

SIGTERM stops receives, cancels processing/heartbeats/FFmpeg, and allows five
seconds to join before aborting remaining processors. An in-progress protection
request and final release may each add four seconds: Task 12 should allow at
least 13 seconds plus margin in `stopTimeout` (30 seconds recommended). Release
occurs only after processors finish; failed release leaves protection to expire.
Incomplete messages remain unacknowledged and recover through lease expiry and
redelivery. Protection cannot prevent crashes or forced stops.

## Resource enforcement

S3 checks both declared length and actual streamed bytes before growing the
input buffer beyond the source limit. The API retains a bounded in-memory
buffer; allow memory for its limit and allocator overhead. The storage and
encoder are shared/serialized, so message concurrency overlaps pipeline stages
and can retain multiple temporary directories without launching that many
simultaneous FFmpeg processes.

Each job reserves its maximum temporary budget against free space and other
reservations before downloading. Admission is conservative and may count
already-written bytes twice. FFprobe rejects invalid/unknown/excessive duration
within ten seconds. FFmpeg has explicit thread/duration limits, a wall-time
bound, and bounded captured output (64 KiB per stream). Linux also applies a
per-file size limit before exec. Total temporary usage and free space are
checked every 100 ms during encoding and again before publication.

The sampled total-size check is not a filesystem quota: writes can cross the
threshold between checks. Preserve disk headroom for that interval and other
processes. Task 12 must size resources for the selected limits. Limit failures
use the existing retry/terminal-failure policy and never mark an incomplete job
completed. Temporary directories are removed on completion/cancellation;
cleanup errors are logged without overwriting a durable completed outcome.

## Local acceptance

From the repository root:

```sh
docker build -t worker-runtime-tests -f app/backend/worker/tests/Dockerfile app/backend/worker/tests
docker run --rm -v "$PWD:/source" -v worker-runtime-cargo:/usr/local/cargo/registry -v worker-runtime-target:/source/app/backend/worker/target worker-runtime-tests bash app/backend/worker/tests/run-local.sh
```

The script creates disposable PostgreSQL instances and valid/expired server
certificates with an explicit `TEST_DATABASE_URL`. It runs the Rust suite,
real TLS, FFmpeg limits/cancellation, SIGTERM tests, and the contract validator,
then stops its databases and removes temporary fixtures. The ordinary suite
also tests a fake ECS agent and SDK task-role credentials through an isolated
subprocess and local HTTP endpoint. No AWS resources are required.

Separately run `go test -C app/backend/api ./...`. Plain test runs without an
explicit database do not count as live database evidence. TLS/media acceptance
tests are ignored in ordinary runs and explicitly executed by the script;
subprocess helper tests are invoked by their parent tests. Actual Fargate role,
protection, and scaling acceptance remains with Tasks 12 and 13.
