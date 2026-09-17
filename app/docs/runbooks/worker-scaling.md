# Worker runtime handoff

## Fargate deployment

The compute root builds no image automatically. Build `app/backend/worker/Dockerfile`,
push the image to the worker ECR repository, and set `worker_image_digest` to the
immutable `sha256:` digest before applying. The service starts with one task and
one receive slot; temporarily set `worker_desired_count = 2` to overlap distinct
jobs during a migration. The database lease remains authoritative while the old
local worker and ECS revisions overlap.

The worker has no ALB target or inbound port. Its task role is limited to the
encoding queue, canonical input reads, HLS output writes, and ECS task protection;
its execution role separately reads the application database secret and writes
CloudWatch logs. `DATABASE_URL` must contain explicit `sslmode=verify-full` (the
container supplies the system CA bundle at `/etc/ssl/certs/ca-certificates.crt`).

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
