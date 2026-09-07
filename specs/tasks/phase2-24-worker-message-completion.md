---
schema_version: 1
id: phase2-worker-message-completion
title: Phase 2 Worker Message Completion and Runtime Wiring
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-message-completion

allowed_paths:
  - app/backend/worker/**

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/**
  - app/infra/**
  - app/backend/api/**
  - app/frontend/**
  - app/compose.yaml
  - app/.env.example
  - app/docs/**

repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Complete the Phase 2 worker by aggregating typed record outcomes into safe SQS acknowledgement/redrive decisions and production runtime wiring after `phase2-worker-queue-visibility`, `phase2-worker-lease-acquisition`, `phase2-worker-heartbeat-lifecycle`, and `phase2-worker-retry-processing` have been merged into `dev`.

# Non-Goals

- Do not change contracts, database schema/semantics, infrastructure, API, frontend, runtime environment values, or Phase 1 encoding/storage behavior.
- Do not add a worker-side DLQ sender/consumer, automatic redrive/replay, new queue, autoscaling, distributed encoding, or retry scheduler.
- Do not make receive-loop success depend on every message becoming terminal in one delivery.
- Do not add CloudFront/OAC, ECS/Fargate, Step Functions, AWS Batch, ABR, or FFmpeg C API work.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, compose/environment files, docs, agent code, or GitHub Workflows.
- Do not delete a message containing any busy, retryable, ownership-lost, infrastructure-uncertain, final-failed, invalid, or unknown record.
- Do not reprocess a `COMPLETED` job, overwrite a terminal state, or roll back `COMPLETED` when DeleteMessage fails.
- Do not allow an expected per-message retry/redrive outcome to terminate the whole long-poll receive loop.
- If any prerequisite is missing or record outcomes cannot be aggregated without violating the contract, stop and escalate.

# Architecture Invariants

- All four worker prerequisite Task Specs are merged into `dev` before implementation begins.
- Every canonical record passes through acquisition and, only when owned, retry-safe processing.
- A message is deleted only when every record is newly/durably `COMPLETED` or was already `COMPLETED`.
- Busy/unexpired, retryable, ownership-lost, infrastructure-uncertain, final `FAILED`, invalid, and unknown outcomes leave the current receipt undeleted for visibility retry/redrive.
- Redelivery of `COMPLETED` performs no download, FFmpeg, upload, lease/state overwrite, or attempt increment and only retries acknowledgement.
- DeleteMessage failure after durable completion preserves `COMPLETED`; later redelivery is an idempotent acknowledgement path.
- Expected record outcomes are logged and isolated per message while the bounded receive loop continues; receive-level failure and controlled shutdown retain their existing meanings.
- Logs include non-secret job/video/attempt/worker outcome context and exclude credentials, database URLs, presigned queries, and receipt handles.

# Tasks

## worker-message-completion: Aggregate record outcomes and wire the resilient worker

depends_on: []

### Requirement

Replace the Phase 1 terminal processor wiring with the acquisition, heartbeat, and retry-safe processing components; aggregate every record disposition into one explicit message decision; apply bounded retry visibility when required; delete only all-completed messages; and keep expected retry/redrive outcomes from stopping the receive loop.

### Acceptance Criteria

- Production startup creates one stable worker identity and wires the Phase 2 queue, persistence, heartbeat, processing, storage, encoding, and acknowledgement boundaries.
- A duplicate during an active lease performs no side effects and remains undeleted; after expiry, exactly one worker can recover it.
- A newly completed or already completed single-record message is deleted only after durable completion evidence.
- Retryable outcomes apply the processor-provided bounded visibility delay and remain undeleted; final failures and poison/invalid/unknown messages remain undeleted for Terraform-managed redrive.
- A multi-record message is deleted only when every record is completed/already completed; any non-acknowledgeable record keeps the whole message.
- DeleteMessage failure after completion cannot change job state and a later delivery deletes without a second encode.
- Expected retry, busy, invalid, final-failure, and redrive outcomes do not stop new long polls; a receive adapter failure still surfaces and shutdown remains bounded.
- Tests cover duplicate delivery, two-worker contention, crash/panic, expired recovery, long heartbeat, every processing outcome, poison input, multi-record mixtures, attempt exhaustion, database/visibility uncertainty, and post-completion delete failure.
- Full worker tests retain the Phase 1 happy path, manifest-last publication, bounded concurrency, cleanup, and structured-log redaction behavior.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
