---
contract_version: 1
contract_id: phase2-reliability
status_schema: job-status.schema.json
storage_contract: storage-conventions.md
s3_event_fixture: ../examples/s3/object-created.json
internal_fields:
  - worker_id
  - attempt
  - lease_expires_at
public_api_exposes_internal_fields: false
publication:
  manifest_name: index.m3u8
  segments_before_manifest: true
  completed_after_manifest: true
---

# Phase 2 reliability contract

This document is the source of truth for Phase 2 worker reliability. It extends
the Phase 1 contracts named in the metadata above; it does not replace or widen
the browser-facing API, the standard S3 notification, or the storage layout.

The authoritative public statuses remain `UPLOADING`, `QUEUED`, `PROCESSING`,
`COMPLETED`, and `FAILED`. The reliability fields below are database and worker
implementation details. They MUST NOT be added to OpenAPI responses, examples,
custom queue events, or playback data.

## Lease fields and ownership

Each job has the following internal fields in addition to its Phase 1 fields:

| Field | Contract |
| --- | --- |
| `worker_id` | Nullable, non-empty opaque identifier for the worker that owns the current processing attempt. It is not an authentication credential. |
| `attempt` | Non-negative integer initialized to `0`. One successful lease acquisition increments it exactly once; claims, busy deliveries, heartbeats, releases, and acknowledgements do not increment it. It never decreases. |
| `lease_expires_at` | Nullable UTC database timestamp. A lease is active only while `lease_expires_at > CURRENT_TIMESTAMP`; equality is expired. Database time, not a worker clock, decides ownership. |

An unowned job has both `worker_id` and `lease_expires_at` set to `NULL`. An
owned job has both set. Only the matching `worker_id` with an unexpired lease
may renew or release the lease, publish more output, persist `COMPLETED`, or
persist terminal `FAILED`. A zero-row conditional update means ownership was
not obtained or was lost; the worker MUST stop processing that job and MUST NOT
perform a terminal state change.

`COMPLETED` is immutable. No acquisition or state-changing statement has
`COMPLETED` in its eligible statuses.

## Event gate and atomic acquisition

Workers continue to accept only the standard S3 `ObjectCreated:*` shape in
`../examples/s3/object-created.json`, the configured input bucket, and the exact
`videos/{video_id}/jobs/{job_id}/source.mp4` key from
`storage-conventions.md`. The Phase 1 conditional claim remains the first
ownership boundary for a newly uploaded job:

```sql
UPDATE jobs
SET status = 'QUEUED',
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND status = 'UPLOADING';
```

Whether this claim affects one row or the event is a redelivery, processing may
start only after the worker obtains the separate lease below. A zero-row Phase
1 claim never authorizes work by itself.

Lease acquisition is one conditional update. It acquires an unowned `QUEUED`
job or replaces an expired owner of a `QUEUED` or `PROCESSING` job, changes the
job to `PROCESSING`, and consumes one attempt:

```sql
UPDATE jobs
SET status = 'PROCESSING',
    worker_id = $3,
    lease_expires_at = CURRENT_TIMESTAMP + $4::interval,
    attempt = attempt + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND status IN ('QUEUED', 'PROCESSING')
  AND attempt < $5
  AND (
        (worker_id IS NULL AND lease_expires_at IS NULL)
        OR lease_expires_at <= CURRENT_TIMESTAMP
      )
RETURNING attempt, lease_expires_at;
```

`$3` is the new `worker_id`, `$4` is the configured lease duration, and `$5` is
the configured maximum attempts. Exactly one returned row means acquired. This
single statement is the only operation that increments `attempt`. An active
lease is busy even when the status is `QUEUED`; an expired lease on either
`QUEUED` or `PROCESSING` is recoverable. Reacquisition restarts processing from
the canonical source object and may overwrite deterministic output keys.

## Owner-only updates

Every owner update uses the job IDs, current `worker_id`, eligible status, and
an unexpired lease in the same SQL statement. Implementations may return more
columns, but MUST preserve these predicates.

### Renewal

```sql
UPDATE jobs
SET lease_expires_at = CURRENT_TIMESTAMP + $4::interval,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND worker_id = $3
  AND status = 'PROCESSING'
  AND lease_expires_at > CURRENT_TIMESTAMP;
```

Renewal does not change `status` or `attempt`. A late renewal cannot revive an
expired lease.

### Retry release

A processing failure while `attempt < maximum_attempts` is retryable. The
current owner releases it with:

```sql
UPDATE jobs
SET status = 'QUEUED',
    worker_id = NULL,
    lease_expires_at = NULL,
    failure_code = NULL,
    failure_message = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND worker_id = $3
  AND status = 'PROCESSING'
  AND lease_expires_at > CURRENT_TIMESTAMP
  AND attempt < $4;
```

This owned retry release is the only permitted `PROCESSING -> QUEUED`
transition. It exposes no failure details through the API. After a successful
release, the worker requests the configured bounded retry visibility delay and
does not delete the SQS message.

### Completion

```sql
UPDATE jobs
SET status = 'COMPLETED',
    worker_id = NULL,
    lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND worker_id = $3
  AND status = 'PROCESSING'
  AND lease_expires_at > CURRENT_TIMESTAMP;
```

This update is attempted only after every referenced segment and then
`index.m3u8` have been uploaded successfully. One updated row is durable
completion; zero rows is ownership loss, not success.

### Exhausted terminal failure

An owned processing failure at `attempt >= maximum_attempts` is terminal. Both
failure values are non-empty and become the existing public `failure` object:

```sql
UPDATE jobs
SET status = 'FAILED',
    worker_id = NULL,
    lease_expires_at = NULL,
    failure_code = $4,
    failure_message = $5,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
  AND video_id = $2
  AND worker_id = $3
  AND status = 'PROCESSING'
  AND lease_expires_at > CURRENT_TIMESTAMP
  AND attempt >= $6
  AND $4 <> ''
  AND $5 <> '';
```

Only an exhausted owned attempt writes `FAILED`. Invalid events, unknown jobs,
busy deliveries, expired owners, and retryable failures do not write terminal
failure details.

## SQS outcome and acknowledgement table

Deleting the received SQS message is the acknowledgement. The worker deletes a
message only after every S3 `Records` item in that message has a durable
`COMPLETED` outcome, including already-completed redelivery. Not deleting it is
a failed delivery for queue purposes; the source queue visibility timeout and
redrive policy decide when it is retried or isolated. The worker never sends a
message directly to a DLQ.

| Outcome | Worker action | Database result | Delete message? |
| --- | --- | --- | --- |
| Acquired | Download, encode, heartbeat, and publish only while ownership remains valid. | `PROCESSING`, new owner, `attempt + 1`. | Not yet; decide from the eventual outcome. |
| Busy / unexpired | Do no download, FFmpeg, upload, release, or terminal update. | No change. | No. Allow redelivery/redrive. |
| Already `COMPLETED` | Perform no download, FFmpeg, or upload. | No change; `COMPLETED` is immutable. | Yes. |
| Final `FAILED` | Perform no processing or state change. | No change. | No. Allow redrive isolation. |
| Invalid event or unknown canonical job | Perform no processing or state change. | No change. | No. Allow redrive isolation. |
| Retryable owned failure | Conditionally release to `QUEUED`, then request the configured retry delay. | Owner and lease cleared; no public failure details. | No. |
| Exhausted owned failure | Conditionally write `FAILED` with non-empty failure details. | Terminal `FAILED`; owner and lease cleared. | No. Allow redrive isolation. |
| Delete failure after durable completion | Do not roll back completion or repeat work. On redelivery, take the already-`COMPLETED` path. | Remains `COMPLETED`. | Retry deletion on redelivery. |

A failed DeleteMessage call never changes the durable outcome. In particular,
redelivery after durable completion exists only to acknowledge the message. A
multi-record notification is acknowledged only when every record is durably
`COMPLETED` or already `COMPLETED`; any busy, retryable, invalid, unknown, or
final-failed record keeps the message unacknowledged.

## Heartbeats and bounded configuration

Let `H` be the heartbeat interval, `V` the visibility extension measured from a
successful SQS extension, `L` the database lease duration measured from a
successful renewal, `R` the retry delay, and `A` the maximum attempts. They are
deployment configuration, not constants in this contract. Startup validation
must enforce:

```text
0 < H < min(V, L)
0 < R <= the queue service's supported per-message visibility bound
1 <= A <= an implementation-defined finite safety bound
```

`H` must leave a configured operational safety margin before both `V` and `L`
expire. `V` and `L` may differ; each must independently exceed `H`. `R` starts
only after the database lease has been released, so it need not be ordered
relative to `L`; it is bounded separately. Queue redrive `maxReceiveCount` is
configured with `A` so repeated non-acknowledged deliveries are eventually
isolated, but queue receives do not change the database `attempt` counter.

During owned work, each heartbeat cycle extends SQS visibility and renews the
database lease. The cycle is successful only when both operations succeed. If
either operation fails or cannot finish before its deadline, the worker marks
local ownership lost, cancels download/FFmpeg where possible, publishes no more
objects, and performs no release, completion, or terminal failure update.

## Crash recovery and publication

- A crash before the Phase 1 claim leaves `UPLOADING`; a redelivery may claim it.
- A crash after the claim but before acquisition leaves an unowned `QUEUED` job;
  a redelivery may acquire it.
- A crash after acquisition leaves a lease that another worker may replace only
  after expiry and while `attempt < A`. The new acquisition increments once.
- If a final attempt crashes rather than reporting a failure, no non-owner may
  fabricate `FAILED` or exceed `A`; the message remains unacknowledged for source
  queue redrive isolation.
- A crash after durable `COMPLETED` but before message deletion is handled as an
  already-completed redelivery and never repeats media work.

All attempts use the unchanged HLS prefix and deterministic segment names in
`storage-conventions.md`. Partial segments and manifests do not make a job
playable through the API. A valid owner may overwrite partial deterministic
objects left by an older attempt. It uploads all segments first and
`index.m3u8` last, then conditionally persists `COMPLETED`. Loss of either
heartbeat signal stops further publication and terminal state changes. The
playback API exposes the manifest only from durable `COMPLETED` state.
