---
schema_version: 1
id: phase2-worker-heartbeat-observation
title: Phase 2 Worker Heartbeat Observation
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-heartbeat-observation

allowed_paths:
  - app/backend/worker/crates/worker/src/heartbeat.rs
  - app/backend/worker/crates/worker/src/completion.rs
  - app/backend/worker/crates/worker/src/main.rs

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/infra/**
  - app/backend/api/**
  - app/backend/worker/crates/persistence/**
  - app/backend/worker/crates/queue/**
  - app/backend/worker/crates/storage/**
  - app/backend/worker/crates/encoding/**
  - app/frontend/**
  - app/scripts/**
  - app/docs/**
  - app/compose.yaml

repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Provide the minimum correlated heartbeat evidence required by Spec 44, extending Spec 25's delivery observation without changing worker ownership, timing, processing, or acknowledgement behavior.

# Non-Goals

- Do not implement crash-recovery or long-heartbeat E2E scenarios, fixture generation, process controls, or environment setup.
- Do not add Terraform, infrastructure, CI changes, dashboards, external telemetry services, dependencies, or production fault hooks.
- Do not change persistence/queue ports, SQL, retry/attempt settings, heartbeat intervals, concurrency, cancellation, publication order, or public API/event contracts.
- Do not reimplement Spec 25's delivery, media-operation, or acknowledgement observations.

# Forbidden Actions

- Do not edit outside `allowed_paths`; keep tests in the allowed Rust modules.
- Do not run Terraform, provision infrastructure, or perform live AWS/database/container mutations during validation.
- Do not log receipt handles, event bodies, credentials, database URLs, presigned queries, raw adapter errors, or debug dumps of message/job objects.
- Do not add service calls, sleep/retry behavior, synchronization barriers, or ownership decisions solely for observation.
- Do not emit success for a skipped operation, zero-row lease update, error, timeout, or cancellation.
- If the existing boundaries cannot supply the required evidence without changing their semantics, stop and report the specific missing capability instead of widening scope or returning a permanently blocked implementation as complete.

# Architecture Invariants

- `phase2-worker-delivery-observation` and `phase2-worker-heartbeat-lifecycle` must already be present on `dev/phase2`, directly or through merged ancestors.
- This Spec is the observation prerequisite for `phase2-reliability-e2e-worker-recovery`. Spec 44 owns E2E assertions and process controls; this work unit owns only backend observation and its offline tests.
- Reuse Spec 25's allowlisted `message_id` and per-receive `delivery_id`. Background heartbeat tasks must explicitly retain the correct delivery context; task spawning does not by itself prove context propagation.
- Lease renewal is per active job; visibility extension is per received message. A multi-record delivery must not turn one SQS call into several reported extensions.
- Database time and conditional updates remain authoritative for ownership. Local monotonic deadlines continue to start before requests exactly as they do now; diagnostic timestamps never control processing.
- A lease operation can succeed before visibility subsequently fails. Report each operation truthfully without treating a partial cycle as successful renewal of both ownership signals.
- Missing/unsafe observation metadata or a disabled subscriber must not change processing behavior. Unsupported evidence remains identifiable to E2E without logging unsafe fallback values.
- Automated completion uses offline tests. Human live verification remains the responsibility of the E2E task and is not required to merge this observation implementation.

# Tasks

## worker-heartbeat-observation: Correlate successful lease and visibility renewal

depends_on: []

### Requirement

Instrument the existing heartbeat task with bounded structured observations for actual successful lease renewals and visibility extensions. Preserve the existing delivery context across the spawned task, identify cycles within each delivery, and expose enough timing information to correlate the last confirmed renewal before a crash. Add a startup capability marker and focused tests of the real emitted events. Use existing tracing dependencies and minimal observation-only wiring in completion/main; keep heartbeat behavior unchanged.

### Acceptance Criteria

- Startup adds `heartbeat_observation_schema=1` while preserving `duplicate_observation_schema=1` and existing startup behavior. The marker denotes the fully implemented event contract below, not an always-blocked stub.
- A successful lease event uses `operation=lease_renewal`, `outcome=success`, and includes `message_id`, `delivery_id`, a per-delivery `heartbeat_cycle` starting at 1, `video_id`, `job_id`, `worker_id`, `attempt`, and `duration_seconds` from the actual configured lease duration.
- A successful visibility event uses `operation=visibility_extension`, `outcome=success`, and includes the same delivery/cycle identity plus `duration_seconds` from the actual extension request. Emit exactly one event per successful message-level extension; use the per-job lease events with that cycle to relate it to acquired owners.
- Both event types include `request_started_at_unix_ms` and `response_observed_at_unix_ms` from local wall time and `elapsed_ms` from a monotonic clock. Document their units and local-clock meaning beside the implementation. Never label a locally computed timestamp as database lease expiry or authoritative SQS expiry; Spec 44 combines these bounds with actual database observations and clock-skew handling.
- Emit success only for a real call whose successful result is accepted by the existing deadline wrapper. A lease result must be `Applied`; the retired-record short circuit that returns `Applied` without calling persistence emits no renewal success. Suppress success when the wrapper rejects a late response.
- Failed, timed-out, cancelled, skipped, or stale-owner operations emit no success event. If lease renewal succeeds and visibility fails, preserve the lease event and emit no visibility success for that cycle. Do not add a new cycle-success claim or change the existing ownership-loss outcome.
- Multiple cycles in one delivery have distinct increasing cycle IDs. Concurrent messages, multi-record jobs, and later redelivery of the same message retain the correct context without mixing delivery IDs, owners, or attempts. Observation counters are not job attempts and never affect state.
- Tests capture actual structured events from the spawned heartbeat, not just formatting helpers. Cover at least two successful cycles; concurrent delivery correlation; multi-record per-job renewal versus one message-level extension; retired records; zero-row updates; database and SQS errors; deadline expiry; cancellation; and partial-cycle success.
- Tests verify success counts and timing fields against controlled calls, preserve secret exclusion using sentinel receipt handles/error strings, and prove that logging-disabled execution retains the same adapter call order, attempt behavior, cancellation, and acknowledgement decisions.
- Existing paused-time heartbeat regression tests continue to pass, including budgets starting before requests, completion retiring leases, and bounded shutdown. Run the full worker workspace regression suite without live credentials or services.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p worker --locked
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml --locked
```
