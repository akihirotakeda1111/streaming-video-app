# Phase 2 reliability conventions

This document is the source of truth for processing ownership, retries, SQS
acknowledgement, and publication. It extends the Phase 1 contracts without
changing the public API, the status schema, the S3 event fixture, or storage
keys. `worker_id`, `attempt`, and `lease_expires_at` are database-only fields;
they are never returned by the Phase 1 OpenAPI responses.

## Lease fields and attempt accounting

Each job has:

| Field | Semantics |
| --- | --- |
| `worker_id` | Nullable opaque worker owner. It is set on acquisition and compared on every owned mutation. |
| `attempt` | Non-negative integer budget counter. Acquisition of an expired or newly queued job increments it exactly once; renewals and retries do not. |
| `lease_expires_at` | Nullable UTC timestamp. Ownership is valid only while it is greater than the database current time. It is set to `current_time + lease_duration` on acquisition and renewal. |

The first `UPLOADING -> QUEUED` conditional claim from the Phase 1 storage
contract remains the first ownership boundary. Processing ownership begins
when a worker acquires a lease for `QUEUED` work. A job in `COMPLETED` is
immutable. A final `FAILED` job is not reacquired.

## Atomic ownership operations

Every statement below is one transactionally atomic conditional update. The
worker proceeds only when exactly one row is affected. `now` means the database
current timestamp, and `worker_id` is the caller's stable identity.

Acquire a new or recovered job, incrementing `attempt` exactly once:

```sql
UPDATE jobs
SET status = 'PROCESSING', worker_id = $worker_id,
    attempt = attempt + 1,
    lease_expires_at = now + $lease_duration,
    updated_at = now
WHERE id = $job_id
  AND status IN ('QUEUED', 'PROCESSING')
  AND (lease_expires_at IS NULL OR lease_expires_at <= now);
```

An expired `PROCESSING` lease is therefore recoverable by the same acquisition
operation and does not increment `attempt` twice. Implementations may instead
make it `QUEUED` in the same transaction, but the status and lease predicates
remain mandatory. An unexpired `QUEUED` or `PROCESSING` lease is busy and
cannot be acquired by another worker.

Renew only the current, unexpired owner before expiry:

```sql
UPDATE jobs
SET lease_expires_at = now + $lease_duration, updated_at = now
WHERE id = $job_id AND worker_id = $worker_id
  AND status = 'PROCESSING' AND lease_expires_at > now;
```

Release an owned retryable failure back to `QUEUED`, without public failure
details or an attempt increment:

```sql
UPDATE jobs
SET status = 'QUEUED', worker_id = NULL, lease_expires_at = NULL,
    failure = NULL, updated_at = now
WHERE id = $job_id AND worker_id = $worker_id
  AND status = 'PROCESSING' AND lease_expires_at > now
  AND attempt < $max_attempts;
```

Complete only the current unexpired owner, and only after the manifest has
been uploaded last and verified published:

```sql
UPDATE jobs
SET status = 'COMPLETED', worker_id = NULL, lease_expires_at = NULL,
    updated_at = now
WHERE id = $job_id AND worker_id = $worker_id
  AND status = 'PROCESSING' AND lease_expires_at > now;
```

Write terminal failure only for the current unexpired owner whose attempt
budget is exhausted; failure details are required and non-empty:

```sql
UPDATE jobs
SET status = 'FAILED', worker_id = NULL, lease_expires_at = NULL,
    failure = $failure, updated_at = now
WHERE id = $job_id AND worker_id = $worker_id
  AND status = 'PROCESSING' AND lease_expires_at > now
  AND attempt >= $max_attempts;
```

`PROCESSING -> QUEUED` is permitted only for an owned retryable failure.
Expired `PROCESSING` work is recovered and may be reacquired; an expired
owner may not complete or finally fail it. Loss of lease or SQS visibility
ownership stops publication and terminal state changes.

## Outcomes and SQS decisions

The worker deletes (acknowledges) an SQS message only when the event has been
handled as a deliberate no-work outcome. Otherwise it leaves the message for
visibility timeout and source-queue redrive; the worker does not produce a
DLQ message.

| Situation | Database/work result | Acknowledge? |
| --- | --- | --- |
| Acquired | Lease acquired and processing runs under the current `worker_id`. | Yes after the owned outcome is durable. |
| Busy/unexpired | Another valid lease owns the job; do no work. | No; redelivery may retry after visibility timeout. |
| Completed | Durable `COMPLETED` is immutable; do no download, FFmpeg, or upload. | Yes; acknowledge-only redelivery. |
| Failed | Final `FAILED` with non-empty failure details is immutable. | No; source redrive isolates the message. |
| Invalid/unknown | Invalid event or unknown canonical job is not successful work. | No; allow source redrive. |
| Retryable failure | Current owner releases to `QUEUED`, clears public failure details, and applies bounded retry delay. | Yes after release is durable. |
| Exhausted failure | Current owner writes terminal `FAILED` with non-empty failure details. | No; source redrive may isolate it. |
| Post-completion delete failure | `COMPLETED` remains durable and immutable even if SQS delete fails. | Retry delete/redelivery; redelivery is acknowledge-only. |

An active lease, final `FAILED` job, invalid event, and unknown canonical job
are not acknowledged as successful work. A message may therefore be isolated
by the source queue's redrive policy.

## Timing and crash recovery

The deployment configures positive bounded values for `heartbeat_interval`,
`visibility_extension_interval`, `lease_duration`, `retry_delay`, and
`max_attempts`. They must satisfy these relationships:

```text
heartbeat_interval < lease_duration
visibility_extension_interval < SQS_visibility_timeout
heartbeat_interval <= visibility_extension_interval
retry_delay <= configured maximum retry delay
attempt <= max_attempts
```

Heartbeats renew both SQS visibility and the database lease periodically, with
bounded intervals and enough margin for one delayed heartbeat. Losing either
signal stops publication and completion/final-failure updates. Retry delay and
maximum attempts are configurable and bounded; deployment values must not be
hard-coded here.

If a worker crashes, the SQS message becomes visible again and an expired
`QUEUED` or `PROCESSING` lease can be recovered by another worker. Partial HLS
objects are unpublished and deterministic keys may be overwritten by the next
valid lease owner. Upload segments first and `index.m3u8` last. `COMPLETED` is persisted
only after manifest publication; incomplete attempts never become playable.

## Unchanged Phase 1 references

The standard fixture remains `contracts/examples/s3/object-created.json`.
The authoritative statuses remain UPLOADING, `QUEUED`, `PROCESSING`,
`COMPLETED`, and `FAILED`. The Phase 1 status set is UPLOADING, `QUEUED`, `PROCESSING`,
`COMPLETED`, and `FAILED`. The OpenAPI response shape remains unchanged, and
the HLS manifest remains
`videos/{video_id}/jobs/{job_id}/hls/index.m3u8` with the manifest uploaded
last.
