# Reliability and Phase 3 delivery evidence matrix

The rows below are the checked-in evidence contract. Rust component tests prove
worker failure invariants offline; helper tests prove runner and delivery validation
logic. Live coverage requires successful redacted evidence from a disposable environment.

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
| Delivery validation offline | `delivery-policy.ts`, `publication-probe.ts`, `delivery-fixtures.ts` and runner helper tests | `npm --prefix app/frontend run test:e2e:helpers` | policy rejection cases, bounded publication observation, fixture selection and historical acceptance validation | Implemented — does not replace live evidence |
| Deployed delivery configuration | `delivery-preflight.spec.ts` (`@delivery-preflight`) | `python app/scripts/run_reliability_e2e.py --scenario delivery-preflight` | deployed distribution, regional S3 origin, SigV4 OAC, four public-access blocks, restricted bucket policy, CORS, zero 403/404 error cache TTL; `delivery-preflight-evidence.json` | Implemented — human disposable live verification outstanding |
| Fresh upload and CloudFront playback | `app/frontend/e2e/direct-upload.spec.ts` (`@phase1-pipeline`) | `python app/scripts/run_reliability_e2e.py --full` (eighth live step) | direct upload, durable API COMPLETED, independently observed S3 publication and bounded CDN negative-cache recovery, HLS MIME/CORS checks, anonymous S3 rejection, positive browser media-time advancement, original manifest key/ETag; `phase1-pipeline-evidence.json` | Implemented — human disposable live verification outstanding |
| Completed-job replay | `delivery-regression.spec.ts` (`@delivery-regression`) | `python app/scripts/run_reliability_e2e.py --scenario delivery-regression --playback-evidence-run e2e-<UUIDv4>` (automatic in `--full`) | selected successful pipeline artifact, live COMPLETED/API/CloudFront/browser checks, original manifest key/ETag preserved; `delivery-regression-evidence.json`, scope `completed-job-replay` | Implemented — human disposable live verification outstanding |
| Pre-cutover Phase 1/2 compatibility | `delivery-regression.spec.ts`; separate full-suite acceptance check | `python app/scripts/run_reliability_e2e.py --scenario delivery-regression --legacy-delivery-fixtures /absolute/path/legacy.json`, then `--full --historical-evidence-run e2e-<UUIDv4>` | inventory captured before cutover, both phases, unchanged original HLS, live browser playback; scope `pre-cutover-compatibility` | Implemented — human disposable live verification outstanding |

The serial gated full-suite command is `python app/scripts/run_reliability_e2e.py
--full`. It runs nine live rows: delivery-preflight, duplicate-delivery,
crash-recovery, long-heartbeat, ffmpeg-exhaustion, poison-isolation,
queue-monitoring, phase1-pipeline, and delivery-regression. The last row
automatically replays the preceding pipeline run. Historical compatibility is a
separate `acceptanceChecks` entry, not a tenth dispatch.

Each successful live row requires its JSON artifact to match the scenario and
run ID and report `passed`; monitoring also requires an empty `outstanding`
list. A blocked dispatch preserves completed rows, marks the blocked row, and
records subsequent checks as unexecuted. `executionStatus=passed` means all nine
current rows passed. Without historical evidence, `acceptanceStatus=incomplete`
and `unexecutedLiveChecks` retains `historical-compatibility`, even when
`status=passed` and the exit code is 0 (`statusScope=current-regression`).
Full acceptance requires valid same-target historical evidence and
`acceptanceStatus=passed`. Invalid supplied historical evidence blocks acceptance
and returns 2; execution/evidence failure returns 1, and blocked execution or
report-write failure returns 2. `componentChecks` declares offline commands and
does not execute them.
The fresh Chromium upload runs without retries and saves redacted network,
pipeline, and browser observations (including video/job IDs and media-time
advancement) in `phase1-pipeline-evidence.json` under its run directory, also on
failure. The final replay saves `delivery-regression-evidence.json`. Retain the
suite report, referenced run directories, and DB/S3 resources needed for replay.
See [runner.md](runner.md) for standalone commands and
the [delivery runbook](../../../docs/runbooks/cloudfront-delivery.md) for the
historical inventory contract. A current completed-job replay does not prove
pre-cutover compatibility.

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
