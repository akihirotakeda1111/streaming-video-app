---
schema_version: 1
id: phase2-reliability-contract
title: Phase 2 Reliability Contract
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-reliability-contract

allowed_paths:
  - app/contracts/**
  - app/scripts/validate_contracts.py

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/scripts/validate_terraform_contracts.py
  - app/infra/**
  - app/backend/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define the minimum Phase 2 reliability contract after the complete Phase 1 happy-path E2E has been merged into `dev`, without changing the public API, the five job statuses, or the canonical S3 object layout.

# Non-Goals

- Do not re-specify or reimplement Phase 1 upload, notification parsing, encoding, HLS publication, status polling, or playback.
- Do not add public retry endpoints, new lifecycle statuses, custom queue events, progress events, or attempt details to the OpenAPI response.
- Do not add CloudFront/OAC, ECS/Fargate, autoscaling, Step Functions, AWS Batch, ABR, multipart segment upload, or FFmpeg C API work.
- Do not prescribe a generic workflow or distributed job framework.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, application code, infrastructure, agent code, GitHub Workflows, or architecture ADRs.
- Do not rename existing statuses or S3 keys, and do not make retry metadata part of the browser-facing contract.
- Do not weaken the rule that `index.m3u8` is uploaded last and `COMPLETED` is persisted only after manifest publication.
- If the Phase 1 happy path is not complete on `dev`, or the required reliability semantics conflict with an existing contract, stop and escalate instead of inventing a parallel contract.

# Architecture Invariants

- The Phase 1 pipeline and `UPLOADING`, `QUEUED`, `PROCESSING`, `COMPLETED`, and `FAILED` remain authoritative.
- The existing `UPLOADING -> QUEUED` conditional claim remains the first ownership boundary for a newly uploaded job.
- Phase 2 adds a database lease for processing ownership; only the current `worker_id` may renew, release, complete, or finally fail its attempt.
- An expired lease on `QUEUED` or `PROCESSING` is recoverable by another worker, and a successful acquisition increments `attempt` exactly once.
- A retryable owned failure releases the job back to `QUEUED` without public failure details; only an exhausted attempt budget writes terminal `FAILED` with non-empty failure details.
- `COMPLETED` is immutable. Redelivery after durable completion performs no download, FFmpeg execution, or upload and exists only to acknowledge the SQS message.
- A message containing an active lease, a final `FAILED` job, an invalid event, or an unknown canonical job is not acknowledged as successful work; SQS redrive is allowed to isolate it.
- Partial HLS output remains unpublished through the API, deterministic keys may be overwritten by the next valid lease owner, and the manifest remains the final uploaded object.
- SQS visibility extension and database lease renewal are periodic, bounded, and configurable; loss of either ownership signal stops publication and terminal state changes.
- Retry delays and maximum attempts are bounded. Poison-message isolation is owned by the source queue redrive policy, not by a worker-side DLQ producer.

# Tasks

## reliability-contract: Define retry, lease, acknowledgement, and publication semantics

depends_on: []

### Requirement

Extend the existing domain contract set with one Phase 2 reliability document and contract validation that define the lease fields, atomic acquisition and renewal conditions, attempt accounting, retryable versus terminal failure outcomes, SQS acknowledgement/redrive decisions, heartbeat timing relationships, crash recovery, and manifest-last publication behavior. Reuse the existing status schema, standard S3 notification fixture, OpenAPI shape, and storage key conventions.

### Acceptance Criteria

- One contract source of truth defines `worker_id`, `attempt`, and `lease_expires_at` semantics without exposing them through the Phase 1 API.
- The contract includes an outcome table for acquired, busy/unexpired, completed, failed, invalid/unknown, retryable failure, exhausted failure, and post-completion delete failure cases.
- Atomic SQL-level conditions are described for acquisition, renewal, retry release, completion, and terminal failure, including current-owner and unexpired-lease checks where applicable.
- The contract states that `PROCESSING -> QUEUED` is permitted only for an owned retryable failure and that expired `PROCESSING` work may be reacquired.
- The contract defines configurable relationships among heartbeat interval, visibility extension, lease duration, retry delay, and maximum attempts rather than hard-coding one deployment scale.
- Existing OpenAPI examples, job statuses, S3 event shape, HLS keys, and manifest-last ordering remain unchanged and valid.
- Contract validation fails if the new reliability document is missing or contradicts the unchanged status/key/publication invariants.

### Validation

```text
python app/scripts/validate_contracts.py
```

# Final Verification

```text
python app/scripts/validate_contracts.py
```
