---
schema_version: 1
id: phase2-worker-retry-processing
title: Phase 2 Worker Retry-Safe Processing
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-worker-retry-processing

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

repair_attempt_limit: 5
review_attempt_limit: 3
---

# Objective

Make one acquired job attempt retry-safe around the existing Phase 1 download, FFmpeg, and HLS publication path after `phase2-worker-lease-acquisition` and `phase2-worker-heartbeat-lifecycle` have been merged into `dev`.

# Non-Goals

- Do not parse/aggregate an entire SQS message, decide DeleteMessage, change receive-loop continuation, or implement DLQ send/replay behavior.
- Do not reimplement S3 event parsing, FFmpeg command construction, HLS naming, segment upload, or manifest-last publication.
- Do not change contracts, migrations, persistence/queue/storage/encoding adapters, Terraform, API, frontend, or monitoring.
- Do not add attempt-specific public prefixes, object transactions, cleanup sweeps, ABR, multipart segment upload, or a separate retry scheduler.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, contracts, infrastructure, adapters, API, frontend, docs, agent code, or GitHub Workflows.
- Do not execute side effects without an acquired lease or continue after heartbeat ownership loss.
- Do not mark `FAILED` before the configured attempt budget is exhausted, and do not write retry failure details into the public job fields.
- Do not mark `COMPLETED` before all segments and `index.m3u8` are uploaded or after lease ownership is lost.
- If either prerequisite is missing or the existing adapters cannot preserve the contract at a side-effect boundary, stop and escalate.

# Architecture Invariants

- `phase2-worker-lease-acquisition` and `phase2-worker-heartbeat-lifecycle` are prerequisites and must already be merged into `dev`.
- Only an acquired disposition can enter processing, and the persisted attempt is the sole maximum-attempt input.
- The existing call order remains `download -> FFmpeg -> segments -> manifest -> owned COMPLETED`.
- Ownership loss/cancellation is checked before download, before FFmpeg output is published, before manifest upload, and before terminal database updates.
- A retryable owned failure below the attempt budget conditionally releases the job to `QUEUED`, clears lease ownership, applies a bounded visibility delay request as an outcome, and leaves public failure fields empty.
- An exhausted owned processing failure conditionally writes existing terminal `FAILED` details and returns a final-failure outcome for later redrive handling.
- Database uncertainty, stale ownership, and heartbeat loss never manufacture `COMPLETED` or `FAILED`.
- Partial deterministic HLS objects may be overwritten by the next owner; only manifest-last plus owned completion makes the API publishable.

# Tasks

## worker-retry-processing: Process one owned attempt into a typed retry or terminal outcome

depends_on: []

### Requirement

Wrap the existing download/encode/publish flow in an owned-attempt processor that coordinates heartbeat cancellation, validates ownership at externally visible boundaries, classifies processing versus ownership/infrastructure failures, conditionally releases retryable work with a bounded delay, and conditionally completes or finally fails only as the current lease owner. Return typed record outcomes without deleting the SQS message.

### Acceptance Criteria

- Maximum attempts and retry-delay bounds are validated at startup and agree with the infrastructure contract.
- Successful work preserves Phase 1 encoding and manifest-last ordering and calls the owned completion transition only after publication.
- Input download, FFmpeg, segment upload, and manifest upload failures release to `QUEUED` with a bounded retry delay while attempts remain.
- The same processing failures write one non-empty terminal `FAILED` result only when the persisted attempt budget is exhausted.
- Persistence errors during renew/release/complete/fail, stale-owner results, heartbeat loss, worker cancellation, and panics produce non-acknowledgeable typed outcomes without false terminal state.
- Partial segment or manifest failure cannot produce `COMPLETED`; a later owned attempt overwrites deterministic required objects and publishes the manifest last.
- A stale worker cannot publish additional output or update job state after a replacement worker acquires the lease.
- Tests cover each existing Phase 1 failure boundary, attempts below/at the limit, bounded retry delay, heartbeat loss at every publication boundary, stale ownership, database uncertainty, partial output, and the unchanged happy-path call order.
- No test or production path deletes, sends, purges, or replays an SQS message in this Task Spec.

### Validation

```text
cargo test --manifest-path app/backend/worker/Cargo.toml -p worker
```

# Final Verification

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
```
