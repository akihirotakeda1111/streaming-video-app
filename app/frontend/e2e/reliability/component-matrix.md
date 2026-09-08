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
| Duplicate delivery / single owner | Spec 43 live scenario | successor selector pending | worker ownership, attempts, transitions, no concurrent processing | Pending — Spec 43 |
| Crash and long heartbeat | Spec 44 live scenario | successor selector pending | worker identity, lease/visibility observations, bounded timeout evidence | Pending — Spec 44 |
| Invalid media / FFmpeg, poison input, exhaustion, DLQ isolation and alarm inspection | Spec 45 live scenarios | successor selectors pending | redacted errors, attempt transitions, DLQ/alarm observations, UTC timestamps | Pending — Spec 45 |
| Phase 1 browser playback | Spec 46 live scenario | successor selector pending | API completion, manifest/segment checks, browser playback trace without unsafe artifacts | Pending — Spec 46 |

The component suite also proves the required distinction between failure before
durable completion and acknowledgement failure after it: retryable failures may
release before completion, while completed redelivery only retries deletion.
Missing live selectors do not count as final coverage.
