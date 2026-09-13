---
schema_version: 1
id: phase2-worker-heartbeat-lifecycle
title: Phase 2 Worker Lease and Visibility Heartbeat Lifecycle
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-heartbeat-lifecycle

allowed_paths:
  - app/backend/worker/Cargo.toml
  - app/backend/worker/Cargo.lock
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
  - app/backend/worker/crates/persistence/**
  - app/backend/worker/crates/queue/**
  - app/backend/worker/crates/storage/**
  - app/backend/worker/crates/encoding/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Add a bounded lifecycle that renews both SQS message visibility and acquired database leases after `phase2-infra-queue-monitoring`, `phase2-job-lease-persistence`, `phase2-worker-queue-visibility`, and `phase2-worker-lease-acquisition` have been merged into `dev`.

# Non-Goals

- Do not download, encode, publish, retry, mark completed/failed, aggregate record outcomes, or delete messages.
- Do not change queue/persistence adapters, Terraform, contracts, API, frontend, or Phase 1 event/storage behavior.
- Do not add a global scheduler, detached daemon, unbounded task set, or heartbeat for messages with no acquired records.
- Do not decide retry delays or maximum-attempt failure behavior.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, adapters, API, frontend, docs, agent code, or GitHub Workflows.
- Do not continue reporting ownership after any required lease renewal or visibility extension fails.
- Do not hide a message for an unbounded duration, renew a lease for another worker, or leak heartbeat tasks after cancellation.
- If any prerequisite is missing or configured timing relationships contradict the reliability contract/Terraform outputs, stop and escalate.

# Architecture Invariants

- All four prerequisite Task Specs are merged into `dev` before implementation begins.
- Heartbeat starts only when the current receipt has at least one acquired record.
- Each tick conditionally renews every acquired job for the same `worker_id` and extends the current SQS receipt visibility.
- The first lease-lost, database-error, or visibility-error result signals ownership loss to the caller and stops further heartbeat activity.
- Normal completion and shutdown cancel and join the heartbeat within a bounded time.
- Heartbeat interval, lease duration, and visibility extension are explicit runtime settings satisfying the reliability contract relationships.
- Time-based tests use a deterministic clock or paused Tokio time and do not wait on wall-clock AWS behavior.

# Tasks

## worker-heartbeat-lifecycle: Coordinate bounded database and SQS ownership renewal

depends_on: []

### Requirement

Add validated heartbeat timing configuration and a cancellable coordinator that periodically renews every acquired job lease through the persistence port and the message receipt visibility through the queue port, returns a typed loss reason, and can be cleanly joined by later processing orchestration.

### Acceptance Criteria

- Startup rejects missing, zero, negative, overflowing, or contract-inconsistent heartbeat interval, lease duration, and visibility-extension values without logging secrets.
- No heartbeat is started for a message with zero acquired records.
- A tick renews only the job IDs/current worker supplied by acquired dispositions and the current message receipt.
- Multi-record tests prove all owned leases are renewed and one message-level visibility extension occurs per tick.
- A stale-owner/expired lease, database failure, or SQS visibility failure produces a distinct typed loss result, stops later ticks, and is observable by the caller.
- Cancellation before the first tick and during a tick both terminate and join without a background-task leak.
- Repeated paused-time ticks use the configured interval and bounded extension values.
- Tests contain no live PostgreSQL or AWS dependency and do not introduce processing, retry, terminal-state, or delete calls.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p worker
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
