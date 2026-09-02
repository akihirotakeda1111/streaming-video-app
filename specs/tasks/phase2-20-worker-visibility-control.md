---
schema_version: 1
id: phase2-worker-visibility-control
title: Phase 2 Worker Visibility Control
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-visibility-control

allowed_paths:
  - app/backend/worker/Cargo.toml
  - app/backend/worker/Cargo.lock
  - app/backend/worker/crates/queue/**
  - app/backend/worker/crates/worker/**
  - app/compose.yaml
  - app/.env.example

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
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Add the SQS receipt metadata, visibility-change adapter, timing configuration, and cancellable heartbeat primitive required by the reliability contract after `phase2-reliability-contract` and `phase2-infra-queue-monitoring` have been merged into `dev`.

# Non-Goals

- Do not change database schema or implement lease acquisition, retry release, final failure, HLS processing, or message outcome policy.
- Do not send messages to the DLQ or consume/replay the DLQ.
- Do not add an independent retry scheduler, background daemon, new queue, or unbounded task spawning.
- Do not change Phase 1 event parsing, storage keys, FFmpeg arguments, or publication order.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, API, frontend, documentation, agent code, or GitHub Workflows.
- Do not hide a message for an unbounded duration or continue reporting ownership after a visibility-change failure.
- Do not log receipt handles, credentials, database URLs, or presigned query strings.
- If either prerequisite is not merged or the runtime timing values contradict the contract/Terraform settings, stop and escalate.

# Architecture Invariants

- `phase2-reliability-contract` and `phase2-infra-queue-monitoring` are prerequisites and must already be merged into `dev`.
- Receive returns the receipt handle and `ApproximateReceiveCount` needed for bounded diagnostics; an absent/invalid receipt handle is never processed as owned work.
- `ChangeMessageVisibility` targets only the configured source queue and current receipt handle.
- Heartbeat starts only after a message has at least one acquired job and stops on completion, cancellation, ownership loss, or its first visibility error.
- Heartbeat intervals and extensions are validated at startup against the contract relationships and do not embed deployment-specific constants in orchestration code.
- Queue adapter tests remain offline through the existing AWS SDK boundary.

# Tasks

## worker-visibility-control: Implement receipt-aware visibility heartbeat boundaries

depends_on: []

### Requirement

Extend the queue port, AWS SQS adapter, worker configuration, fakes, and lifecycle primitives to receive approximate delivery count, change the current receipt visibility, schedule bounded periodic extensions, and signal loss to a caller. Do not yet decide job retry, acknowledgement, or terminal state outcomes.

### Acceptance Criteria

- SQS receive requests `ApproximateReceiveCount` and maps it to a validated positive value without exposing the receipt handle in logs.
- The queue port and AWS adapter support `ChangeMessageVisibility` for the configured source queue and receipt.
- Startup configuration validates heartbeat interval, visibility extension, lease duration, retry-delay ceiling, and maximum attempts using the contract timing relationships.
- A deterministic-clock or paused-time test proves heartbeats occur at the configured interval and stop cleanly when cancelled.
- The first visibility-change failure is surfaced to the caller, stops further extensions, and cannot be mistaken for continued ownership.
- Cancellation is bounded and does not leak a heartbeat task after message processing ends.
- Existing long polling, bounded concurrency, delete behavior, and offline AWS adapter tests continue to pass.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p queue -p worker
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
