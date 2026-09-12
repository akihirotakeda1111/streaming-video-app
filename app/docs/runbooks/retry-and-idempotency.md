# Retry and idempotency runbook

This is an operator guide for the Phase 2 worker contract. It applies only to
an explicitly disposable E2E environment. The contract is
[`reliability-conventions.md`](../../contracts/domain/reliability-conventions.md);
the executable evidence matrix is
[`component-matrix.md`](../../frontend/e2e/reliability/component-matrix.md).

## What to observe

Use database time for ownership decisions. An active lease is
`lease_expires_at > CURRENT_TIMESTAMP`; equality is expired. Read the target
job by its canonical video/job IDs and record only redacted IDs, UTC timestamps,
status, attempt, worker ownership (opaque worker ID may be shortened), and
whether a manifest exists. Never decide ownership from a worker clock.

The following symptoms have these expected meanings:

| Symptom | Safe interpretation and action |
| --- | --- |
| Duplicate delivery while `QUEUED` or `PROCESSING` has an unexpired lease | Busy delivery. Do no download, FFmpeg, upload, release, or terminal update. Leave the message unacknowledged and wait for normal visibility/redrive. |
| Delivery of `COMPLETED` | Completed redelivery. Do no media work; retry only message deletion. A delete failure must not roll back completion or cause re-encoding. |
| Crash after acquisition | Wait for both the database lease and SQS visibility to expire, then observe one replacement acquisition if `attempt < A`. A final-attempt crash remains unacknowledged and must not be fabricated into `FAILED`. |
| Heartbeat loss | The worker must stop publication and terminal updates when either visibility extension or lease renewal fails. Treat ownership as lost; do not release or complete as a non-owner. |
| Transient download, upload, or database failure | A valid owner may release `PROCESSING` to `QUEUED` only while its lease is active and `attempt < A`. It must not acknowledge the message. Database errors or stale ownership never mean success. |
| FFmpeg failure | Observe bounded retry releases, then terminal `FAILED` only on an owned exhausted attempt. No manifest may be published before successful completion. |
| Attempt exhaustion | `attempt` is consumed only by successful lease acquisition and never decreases. Once `attempt >= A`, an owned processing failure may become terminal `FAILED`; no later acquisition is allowed. |
| Post-completion delete failure | Durable `COMPLETED` is authoritative. The next delivery only retries acknowledgement; it must not encode again. |

`attempt` is the database job-attempt count. SQS `ApproximateReceiveCount`
is a queue delivery count used by redrive and is not an attempt increment.
Busy deliveries, claims, heartbeats, releases, and acknowledgements do not
increment `attempt`.

## Bounded waiting

Read the generated values rather than inventing a timeout. The runner requires
all seven `E2E_*_TIMEOUT_MS` values to be integers from 1 to 900000:

| Bound | Meaning |
| --- | --- |
| `E2E_NAVIGATION_TIMEOUT_MS` | 30000 ms generated default |
| `E2E_UPLOAD_TIMEOUT_MS` | 120000 ms generated default |
| `E2E_PROCESSING_TIMEOUT_MS` | 300000 ms generated default |
| `E2E_PLAYBACK_TIMEOUT_MS` | 120000 ms generated default |
| `E2E_VISIBILITY_TIMEOUT_MS` | `max(queue visibility, worker extension) * 1000 + 30000` |
| `E2E_LEASE_TIMEOUT_MS` | `worker lease * 1000 + 30000` |
| `E2E_DLQ_TIMEOUT_MS` | `worker retry delay * 1000 + 30000` |

The worker requires `2 * heartbeat <= min(visibility extension, lease)`.
For FFmpeg exhaustion, wait no longer than
`PROCESSING + (A - 1) * retry + VISIBILITY + DLQ`, then perform the documented
post-DLQ visibility/state/no-extra-encoding check. Poison isolation uses
`A * VISIBILITY + DLQ`. The runner's dedicated Terraform defaults are
`A=3`, retry `10s`, visibility `120s` (generated FFmpeg ceiling 510s and
post-DLQ confirmation 150s). Stop at the bound and escalate with retained
evidence; do not poll indefinitely.

## Commands and prerequisites

Run from the repository root, in the same shell that loaded generated,
non-secret E2E settings. The target must be disposable, exclusive to this run,
and use the validated local Docker worker/database, dedicated buckets, source
queue, and DLQ. API/Frontend/Chromium and fixtures are additionally required
for browser scenarios. Do not print credentials, database URLs, full signed
URLs, query strings, or receipt handles.

Offline check (does not run a live scenario):

```text
python app/scripts/run_reliability_e2e.py --check
```

Live boundary check, before every scenario:

```text
python app/scripts/run_reliability_e2e.py --live-preflight
```

Run the relevant live scenario only after `--live-preflight` reports
`status=verified`:

```text
python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery
python app/scripts/run_reliability_e2e.py --scenario crash-recovery
python app/scripts/run_reliability_e2e.py --scenario long-heartbeat
python app/scripts/run_reliability_e2e.py --scenario ffmpeg-exhaustion
```

The runner creates a unique `e2e-<UUIDv4>` evidence directory and authorizes
the same validated worker/database boundary before dispatch. Do not replace
the evidence parent with a child directory or run scenarios concurrently.

## Ownership, recovery, and escalation

Manual recovery requires all of the following: explicit human intent; the exact
disposable target; exact canonical message/job identity; resolved root cause;
no active owner by a database-time check; and an eligible non-terminal state
with remaining attempt budget. A `COMPLETED` job must never be re-encoded.
Terminal `FAILED` or an exhausted crashed job cannot be made retryable by
replaying its message alone.

If recovery would require resetting state or the attempt budget, editing the
database, replaying a message through an unsupported path, bulk purging, or
inventing a repair mechanism, stop and escalate to the service owner. Do not
delete or replay unrelated messages. If ownership, target identity, state, or
the contract is uncertain, retain redacted evidence and escalate.

Cleanup is limited to canonical resources created by the current run: its
database rows and input/output objects, as permitted by the scenario. Never
clean up by queue purge or broad bucket deletion. Verify the worker is restored
after crash injection and record cleanup outcome.

## Final human verification

Offline component checks and the matrix are not MVP sign-off. Human Terraform
verification must confirm the plan targets only the disposable E2E resources,
the queue redrive relationship, timing values, alarms, IAM boundaries, and
labels before live execution. Then retain a successful full report:

```text
python app/scripts/run_reliability_e2e.py --full
```

`--full` serially runs the six reliability selectors, correlates the monitoring
run with the FFmpeg and poison run IDs, and finally runs fresh Chromium
`@phase1-pipeline` playback without retries. Retain `full-suite-*.json`, every
referenced scenario JSON, and `phase1-pipeline-evidence.json` under the same
evidence parent. Sign-off requires every row `passed`, monitoring
`outstanding=[]`, durable API `COMPLETED`, segment-before-manifest checks, HLS
object checks, and positive browser media-time advancement. Missing live or
Terraform evidence remains outstanding and must be reported, even when
offline checks pass.
