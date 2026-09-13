---
schema_version: 1
id: phase2-worker-delivery-observation
title: Phase 2 Worker Delivery Observation
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-delivery-observation
allowed_paths:
  - app/backend/worker/crates/queue/src/lib.rs
  - app/backend/worker/crates/queue/src/sqs.rs
  - app/backend/worker/crates/worker/src/completion.rs
  - app/backend/worker/crates/worker/src/main.rs
  - app/backend/worker/crates/worker/src/publish.rs
  - app/backend/worker/crates/worker/src/retry.rs
  - app/backend/worker/crates/worker/src/runtime.rs
forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/infra/**
  - app/backend/api/**
  - app/frontend/**
  - app/compose.yaml
repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Provide the minimum correlated Worker evidence required by Spec 43 without changing queue, lease, retry, processing, or acknowledgement behavior.

# Non-Goals

- Do not add reliability scenarios, provisioning, Terraform execution, dashboards, or production fault hooks.
- Do not change public API/event contracts, persistence semantics, attempt budgets, concurrency, or publication order.

# Forbidden Actions

- Do not edit outside allowed_paths.
- Do not log event bodies, receipt handles, credentials, database URLs, presigned queries, or raw adapter errors.
- Do not treat observation identifiers as authority to acquire a lease or acknowledge a message.

# Architecture Invariants

- `phase2-worker-message-completion` must be present on `dev/phase2` before this work begins.
- SQS message identity correlates repeated deliveries; a fresh delivery identifier distinguishes concurrent receives of that same message. Receipt handles remain private.
- Missing/unsafe observation metadata cannot change production behavior. Live E2E must reject insufficient evidence.
- Only the existing successful DeleteMessage path emits a deleted outcome. Busy messages remain undeleted and completed redelivery performs no media work.

# Tasks

## worker-delivery-observation: Correlate delivery, media side effects, and acknowledgement

depends_on: []

### Requirement

Carry the optional SQS message ID through the internal queue port and add bounded, non-secret delivery spans. Correlate acquired/busy/already-completed outcomes, side-effect start/success events, completion, and deletion through those spans. Emit a startup capability marker so live scenarios can refuse unsupported images before creating resources.

### Acceptance Criteria

- The startup marker identifies `duplicate_observation_schema=1`.
- Message IDs are allowlisted for observation; UUID delivery IDs differ between receives. Neither replaces the receipt handle for SQS operations.
- Download, encode, segment upload and manifest upload start/success logs inherit canonical job/video, owner/attempt and delivery context.
- Successful publication remains segments first, manifest last, then durable completion, then message deletion.
- Tests exercise actual structured logs, context propagation, secret exclusion, and absence of media work on busy/completed deliveries.
- Existing queue and worker regression tests retain their original behavior.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p queue -p worker --locked
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p queue -p worker --locked
```
