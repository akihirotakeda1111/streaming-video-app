---
schema_version: 1
id: phase2-worker-queue-visibility
title: Phase 2 Worker SQS Receipt and Visibility Adapter
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-queue-visibility

allowed_paths:
  - app/backend/worker/Cargo.toml
  - app/backend/worker/Cargo.lock
  - app/backend/worker/crates/queue/**
  - app/backend/worker/crates/worker/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/**
  - app/infra/**
  - app/backend/api/**
  - app/backend/worker/crates/persistence/**
  - app/backend/worker/crates/storage/**
  - app/backend/worker/crates/encoding/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Add the receipt metadata and SQS visibility-change adapter required by Phase 2 after `phase2-reliability-contract` and `phase2-infra-queue-monitoring` have been merged into `dev`.

# Non-Goals

- Do not implement timer scheduling, heartbeat lifecycle, database lease renewal, job acquisition, retry classification, terminal state, or message acknowledgement policy.
- Do not send messages to or consume messages from the DLQ.
- Do not change event parsing, source download, FFmpeg, HLS publication, or worker concurrency behavior.
- Do not add a retry queue, scheduler, or new AWS client outside the existing queue adapter boundary.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, persistence/storage/encoding adapters, frontend, docs, agent code, or GitHub Workflows.
- Do not accept an empty receipt handle as processable work or expose receipt handles in logs/errors intended for operators.
- Do not hard-code queue URLs, visibility durations, credentials, or deployment-specific retry values.
- If either prerequisite is not merged or the required IAM/resource contract differs from the existing source queue, stop and escalate.

# Architecture Invariants

- `phase2-reliability-contract` and `phase2-infra-queue-monitoring` are prerequisites and must already be merged into `dev`.
- SQS remains a Standard queue consumed through the existing long-poll adapter.
- A received message carries a non-empty current receipt handle and validated positive `ApproximateReceiveCount`.
- `ChangeMessageVisibility` targets only the configured source queue and the current receipt handle.
- This Task Spec exposes queue capabilities; it does not decide when to heartbeat, retry, delete, or redrive.
- AWS adapter tests remain offline through the existing SDK seam.

# Tasks

## worker-queue-visibility: Add delivery metadata and visibility control to the queue port

depends_on: []

### Requirement

Extend the queue message type, port, AWS SDK adapter, and fakes to request and validate `ApproximateReceiveCount` and to change the visibility timeout of the current receipt. Make only the mechanical worker test-fixture updates required by the expanded message type; leave orchestration behavior unchanged.

### Acceptance Criteria

- Receive requests `ApproximateReceiveCount` and maps a valid positive value into the queue message type.
- Missing, malformed, zero, or negative delivery counts and empty receipt handles fail safely before job processing.
- A dedicated queue capability changes visibility for the configured source queue, current receipt handle, and caller-provided bounded duration.
- The adapter does not provide DLQ send, queue purge, visibility cancellation policy, or delete policy.
- Queue errors do not include credentials or raw receipt handles.
- Existing long polling and DeleteMessage behavior remain unchanged.
- Unit tests cover valid/missing/invalid delivery count, empty receipt, visibility request arguments, SDK failure, and unchanged receive/delete calls without contacting AWS.
- Worker crate tests compile with the expanded message fixture but gain no Phase 2 orchestration behavior in this Task Spec.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p queue -p worker
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
