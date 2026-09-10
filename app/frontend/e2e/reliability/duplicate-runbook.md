# Duplicate delivery: execution and evidence

This scenario uses an already prepared disposable AWS/Docker environment. It does
not create infrastructure, run Terraform, change IAM, stop a worker, or replay a
queue. Common environment variables and read-only preflight are described in
[runner.md](runner.md). CI performs offline checks only; a human runs live checks.

## Prerequisites

- The Worker image includes the separate `phase2-worker-delivery-observation`
  prerequisite. Its startup JSON log must contain `duplicate_observation_schema=1`.
  The scenario refuses older images before creating resources. Rebuild/deploy the
  image through the existing environment workflow; the test does not do so.
- The supported Worker and PostgreSQL containers satisfy the existing live
  preflight. All resources are dedicated to this run: set
  `E2E_DUPLICATE_EXCLUSIVE=true` only after confirming there are no other tests or
  consumers. The adapter also refuses a database containing active jobs.
- Source/output buckets have never had versioning enabled. Versioned or suspended
  buckets are rejected because this adapter cannot safely clean object versions.
  There is exactly one matching direct input-bucket notification to the Standard
  source queue. No fanout or FIFO queue is supported.
- `E2E_DUPLICATE_FIXTURE` is an absolute path to a valid, nonempty MP4, at most
  1 GiB. Use a workload whose actual encode lasts long enough to observe processing,
  send a duplicate, and observe a busy delivery. A short workload is unverified,
  never a pass. Do not extend it so far that busy deliveries exhaust the existing
  queue redrive count before completion. Timing settings are never changed by E2E.
- The calling AWS identity has the existing preflight read access, plus source
  queue `sqs:SendMessage`, bucket notification/versioning/list metadata access,
  and read/write/delete access to the run's canonical objects. Docker access
  permits bounded logs/inspect and PostgreSQL `psql` execution. The database role
  can create/read/delete the run's video and job rows. Worker credentials retain
  their existing processing permissions; no new credential files are generated.

## Run

From the repository root, after loading the common disposable environment values:

```powershell
$env:E2E_DUPLICATE_EXCLUSIVE = 'true'
$env:E2E_DUPLICATE_FIXTURE = (Resolve-Path 'C:/e2e/fixtures/long.mp4').Path
python app/scripts/run_reliability_e2e.py --live-preflight
python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery
```

`--list` and `--check` remain offline. The Python runner invokes the installed
Playwright CLI through Node and selects only the reliability project and
`@duplicate-delivery`. Direct Playwright selection also performs live preflight.
The scenario creates canonical test rows through the existing database schema
and uploads the source through S3. Browser upload/playback regression remains
owned by the Phase 1 pipeline and Spec 46.

Each run performs:

1. Upload a fresh canonical source and observe the original owner encoding.
2. Send a standard single-record S3 ObjectCreated notification for the same source.
   Observe that exact message's busy/retained delivery while the original lease
   is active, with the same owner and attempt in PostgreSQL.
3. Observe one download/encode/publication, manifest-last completion, and eventual
   deletion of the original and busy messages by the Worker.
4. Send another duplicate after durable completion. Observe already-completed and
   deletion for that message, with no media side effects or job update, including
   no change to `updated_at`.
5. Verify exact output keys and nonempty HLS metadata, then clean run resources.

## Evidence and bounds

The runner prints the local evidence directory before dispatch. The scenario
writes `duplicate-delivery-evidence.json` there and attaches the same sanitized
record to Playwright. It includes run/video/job IDs, the three SQS message IDs,
per-receive delivery IDs, owner/attempt context, side-effect events, observed
leases and state transitions, and cleanup status. `observedAtMs` is PostgreSQL
time in epoch milliseconds; event `at` values are Worker UTC timestamps. Secrets,
receipt handles, raw event bodies, raw Docker logs and URL queries are excluded.

The Spec 25 log contract uses `worker_delivery` (`message_id`, `delivery_id`)
and nested `worker_attempt` (`job_id`, `video_id`, `worker_id`, `attempt`) spans.
Media events use `operation=download|encode|segment_upload|manifest_upload`
and `outcome=start|success`; the evidence normalizes these into stage labels
such as `encode_started` and `encode_finished`. The schema marker is checked
only in the startup event. Missing/unsafe SQS metadata becomes `unknown` in
Worker logs and cannot establish E2E correlation, so it is rejected.

Worker logs do not contain source or output keys. Source scope comes from the
canonical run rows and single-record notification. Segment start/success pairs
establish upload count and ordering, followed by one manifest pair. The adapter
derives the expected `segment-00000.ts` sequence and `index.m3u8` from that count,
then independently compares the S3 object listing and metadata. Derived keys
are expectations, not per-object keys observed in Worker logs.

`E2E_PROCESSING_TIMEOUT_MS` bounds processing, output checks and cleanup phases.
Delivery waits use `E2E_VISIBILITY_TIMEOUT_MS + E2E_NAVIGATION_TIMEOUT_MS` to allow
busy-message redelivery plus receive/polling overhead. Commands are bounded to
10 seconds, except the source upload which uses `E2E_UPLOAD_TIMEOUT_MS`. Output
listing is capped at 512 objects and correlated logs at 20,000 events/16 MiB.
Use a fixture compatible with these limits. No automatic scenario retries occur.

Success requires exit code 0, `status=passed` and `cleanup=complete`. Offline test
success alone is not live acceptance; retain reviewed human-run evidence before
marking Spec 43 live validation complete.

## Failure and cleanup

Upload failures retain resources and include a fixed diagnostic category in the
evidence `reason`, for example `Upload outcome uncertain; retain run resources.
[access_denied] ...`. No raw stderr, command arguments, credentials, or connection
strings are retained. Categories include `access_denied`, `credentials_missing`,
`credentials_expired`, `credentials_invalid`, `signature_mismatch`, `timeout`,
`network`, `tls`, `file_read`, `bucket_missing`, `region_mismatch`, `cli_missing`,
`process_permission`, `response_too_large`, `invalid_response`, and `unknown`.
These are diagnostic hints, not proof of whether the remote upload completed.
Authentication refers to the host AWS CLI identity, not the Worker identity.
Inspect the category and its fixed advice before rerunning; unsupported CLI error
formats remain `unknown` rather than exposing raw error text.

On timeout or assertion failure, cleanup can still wait within its own bounded
budget for durable completion and the latest observed deliveries of every known
message to be acknowledged. It never calls ReceiveMessage, DeleteMessage, purge,
or redrive itself. Successful cleanup lists and validates all object keys before
deleting only the exact source and deterministic HLS keys, then deletes the video
row guarded by video ID, run-specific filename and source key (jobs cascade).

An ambiguous upload/send, pending message, active lease, changed container,
unexpected object, or unverifiable row ownership leaves resources in place and
sets `cleanup=retained`, `status=unverified`. Partial local setup also runs the
ownership checks. Inspect the evidence and exact canonical IDs manually; do not
purge queues, reset job state, or delete shared prefixes to force a pass. Standard
queues can exceptionally redeliver even after acknowledgement; the test proves
observed delivery outcomes, not perpetual queue emptiness. Inspect any later
run-specific unknown-job delivery through the existing manual recovery process.

Backend observation code is a separate prerequisite, not a production behavior
repair. Its optional SQS ID and delivery spans only observe the existing pipeline;
missing metadata never changes acquisition or acknowledgement decisions.
