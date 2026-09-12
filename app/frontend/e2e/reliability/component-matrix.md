# Phase 2 reliability evidence matrix

The rows below are the checked-in evidence contract. Rust component tests are the
authoritative offline proof; live rows belong to the named successor Spec and are
pending until that Spec supplies an executable selector and redacted evidence.

| Failure or behavior | Actual coverage / successor | Command | Required evidence | Status |
| --- | --- | --- | --- | --- |
| Download failure | `app/backend/worker/crates/worker/src/retry.rs::tests::each_pipeline_failure_obeys_attempt_budget_and_cleans_up` (stage 0) | `cargo test --manifest-path app/backend/worker/Cargo.toml each_pipeline_failure_obeys_attempt_budget_and_cleans_up` | no completion; retry before durable completion; cleanup | Covered |
| Partial segment upload | `app/backend/worker/crates/worker/src/completion.rs::tests::partial_upload_redelivery_reacquires_and_publishes_before_acknowledgement` | `cargo test --manifest-path app/backend/worker/Cargo.toml partial_upload_redelivery_reacquires_and_publishes_before_acknowledgement` | state transitions, deterministic keys, attempts, encode count, ack order | Covered |
| Manifest upload failure | `app/backend/worker/crates/worker/src/retry.rs::tests::each_pipeline_failure_obeys_attempt_budget_and_cleans_up` (stage 4) | `cargo test --manifest-path app/backend/worker/Cargo.toml each_pipeline_failure_obeys_attempt_budget_and_cleans_up` | no completion before manifest; bounded retry/final failure; no leaked workdir | Covered |
| Database update failure | `app/backend/worker/crates/worker/src/retry.rs::tests::stale_owner_and_database_errors_never_report_terminal_success` | `cargo test --manifest-path app/backend/worker/Cargo.toml stale_owner_and_database_errors_never_report_terminal_success` | returned database errors yield InfrastructureFailure; stale ownership yields OwnershipLost; neither reports terminal success | Covered |
| Post-completion delete failure | `app/backend/worker/crates/worker/src/completion.rs::tests::delete_failure_redelivery_only_retries_acknowledgement` | `cargo test --manifest-path app/backend/worker/Cargo.toml delete_failure_redelivery_only_retries_acknowledgement` | durable COMPLETED, no repeat encoding, delete retry only | Covered |
| Duplicate delivery / single owner | `duplicate-delivery.spec.ts` (`@duplicate-delivery`), `duplicate-driver.ts`, `duplicate-adapter.ts`; offline `duplicate-*.test.ts` | `python app/scripts/run_reliability_e2e.py --scenario duplicate-delivery` | Correlated message/delivery IDs, busy and acknowledgement outcomes, owner/attempt snapshots, one encode/publication, unchanged completion, scoped cleanup; see `runner.md` | Implemented — human disposable live verification outstanding |
| Crash and long heartbeat | `lifecycle.spec.ts` (`@crash-recovery`, `@long-heartbeat`), `lifecycle-driver.ts`, `lifecycle-adapter.ts`; offline lifecycle tests | `python app/scripts/run_reliability_e2e.py --scenario crash-recovery` and `python app/scripts/run_reliability_e2e.py --scenario long-heartbeat` | worker identity, lease/visibility observations, bounded timeout evidence, restoration and scoped cleanup | Implemented — human disposable live verification outstanding |
| FFmpeg failure | `ffmpeg-exhaustion.spec.ts` (`@ffmpeg-exhaustion`), `ffmpeg-exhaustion-driver.ts`; offline `ffmpeg-exhaustion-driver.test.ts` and `dlq-correlation.test.ts` | `python app/scripts/run_reliability_e2e.py --scenario ffmpeg-exhaustion` | real invalid-media FFmpeg failure, redacted failure details, bounded acquisition attempts, UTC timestamps | Implemented — human disposable live verification outstanding |
| Attempt exhaustion | `ffmpeg-exhaustion.spec.ts` (`@ffmpeg-exhaustion`), `ffmpeg-exhaustion-driver.ts` | `python app/scripts/run_reliability_e2e.py --scenario ffmpeg-exhaustion` | durable FAILED at configured acquisition budget; no further encoding or attempt increment | Implemented — human disposable live verification outstanding |
| Failed-job DLQ isolation | `ffmpeg-exhaustion.spec.ts` (`@ffmpeg-exhaustion`), `dlq-correlation.ts` | `python app/scripts/run_reliability_e2e.py --scenario ffmpeg-exhaustion` | exact run-owned message/body correlation, no receipt handles, no unrelated deletion or replay | Implemented — human disposable live verification outstanding |
| Malformed / unknown-job poison input and DLQ isolation | `poison-isolation.spec.ts` (`@poison-isolation`), `poison-isolation-driver.ts`, `poison-isolation-adapter.ts`; offline helper/driver assertions | `python app/scripts/run_reliability_e2e.py --scenario poison-isolation` | exact run-owned malformed and unknown-job DLQ correlation, no job mutation or known-job attempt consumption, concurrent valid-job completion, UTC timestamps; DLQ receive changes visibility and is gated/disposable-only | Implemented — human disposable live verification outstanding |
| Source backlog/age, DLQ depth and queue/alarm inspection | `queue-monitoring.spec.ts` (`@queue-monitoring`), `queue-monitoring.ts`; offline helper assertions | `python app/scripts/run_reliability_e2e.py --scenario queue-monitoring` | read-only source/DLQ attributes and CloudWatch metrics, alarm identifiers and actual states/reasons including `INSUFFICIENT_DATA`, bounded observation timestamps, correlation with Specs 45/46 evidence; missing evidence remains outstanding | Implemented — human disposable live verification outstanding |
| Phase 1 browser playback | `app/frontend/e2e/direct-upload.spec.ts` (`@phase1-pipeline`) | `node app/frontend/node_modules/@playwright/test/cli.js test --grep @phase1-pipeline --project chromium` (or `python app/scripts/run_reliability_e2e.py --full` for the gated final step) | direct upload, durable API COMPLETED, segment-before-manifest evidence, HLS object checks, player/network/CORS assertions, positive media-time advancement, redacted IDs | Implemented — human disposable live verification outstanding |

The serial gated full-suite command is `python app/scripts/run_reliability_e2e.py
--full`. It runs all six live reliability selectors in matrix order and only
then runs the fresh `@phase1-pipeline` upload. Its redacted `full-suite-*.json`
report separates declared component checks, live evidence, and unexecuted live
checks; any failed or unexecuted row makes the suite non-success.

Each successful live row requires its JSON artifact to match the scenario and
run ID and report `passed`; monitoring also requires an empty `outstanding`
list. A blocked dispatch preserves completed rows, marks the blocked row, and
records subsequent checks as unexecuted. Exit codes are 0 for success, 1 for
failed execution/evidence, and 2 for blocked execution or report-write failure.
The final Chromium upload runs without retries and saves redacted network,
pipeline, and browser observations (including video/job IDs and media-time
advancement) in `phase1-pipeline-evidence.json` under its run directory, also on
failure. Retain the suite report together with its referenced run directories.

Queue monitoring can explicitly reuse the two earlier run artifacts with
`--ffmpeg-evidence-run e2e-<UUIDv4>` and `--poison-evidence-run e2e-<UUIDv4>`;
keep `E2E_EVIDENCE_DIR` set to the same parent directory for all three runs.
See `runner.md` for the full command and completion criteria. The monitoring run
remains distinct; missing or mismatched references are outstanding, and only
complete passed isolation artifacts plus actual metric/alarm observations pass.

The component suite also proves the required distinction between failure before
durable completion and acknowledgement failure after it: retryable failures may
release before completion, while completed redelivery only retries deletion.
Missing live selectors do not count as final coverage.
