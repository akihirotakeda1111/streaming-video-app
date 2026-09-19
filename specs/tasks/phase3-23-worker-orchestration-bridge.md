---
schema_version: 1
id: phase3-worker-orchestration-bridge
title: Phase 3 Worker Orchestration and Reliability Bridge
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-worker-orchestration-bridge

allowed_paths:
  - app/backend/worker/**
  - app/docs/runbooks/distributed-encoding.md
  - app/.env.example
  - app/compose.yaml

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Run Step Functions within the existing SQS worker ownership period and connect its outcomes to established heartbeat, retry, and acknowledgement semantics.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-step-functions-orchestration` (`phase3-22-step-functions-orchestration.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## worker-orchestration-bridge: Phase 3 Worker Orchestration and Reliability Bridge

depends_on: []

### Requirement

**Scope / Allowed Changes:** Add a distributed path through the existing acquisition flow. The deployment-selected mode (cli or distributed) must participate in the first successful acquisition: an unresolved mode is atomically fixed to the selected mode at acquisition, and reacquisition must preserve and return the already-persisted mode. Runtime branching must use only the persisted mode returned by acquisition; do not select or change the mode after acquisition.

Keep the deployment-selected mode set to cli until Task 24 is complete and distributed publication/finalization is available.

Continue both database-lease and SQS-visibility heartbeats while starting and polling executions with bounded backoff. Reuse the S3 event gate, all-record COMPLETED acknowledgement, and non-acknowledgement for busy/failed/unknown records. Task 23 owns the finalizer port/interface required to hand off a successful Step Functions outcome, but does not implement distributed publication or parent master assembly. Define and connect this port within the worker runtime so orchestration completion can be handed off without treating Step Functions SUCCEEDED as job completion.

Provide test/fake implementations of the finalizer port sufficient to verify orchestration-to-finalizer control flow, ownership fencing, failure propagation, and acknowledgement gating. Task 24 owns the concrete distributed finalizer implementation that validates child result descriptors and referenced objects, publishes the parent master manifest last, and performs distributed database completion.

Do not duplicate or partially implement Task 24's child-result validation, master-playlist assembly, publication ordering, or distributed completion logic in this task.

Resolve lost StartExecution responses using a deterministic job/attempt name and exactly identical input. Do not generate new names when an execution has conflicting input or has already failed. Map permission, timeout, and child failures to existing owned release/terminal-failure operations only while ownership remains valid; only reacquisition increments the attempt. On loss of either the SQS visibility heartbeat or the database lease heartbeat, mark local ownership lost and attempt Step Functions execution cancellation on a best-effort basis.

After ownership loss, do not publish further objects, release the job, complete the job, write terminal failure state, or acknowledge the SQS message. Execution cancellation is not an ownership fence and does not restore authority to perform database state transitions. Surviving child tasks and objects remain isolated to their original attempt and must not authorize completion of a later attempt.

After a parent crash, a new attempt derives the previous execution identity and attempts bounded inspection/cancellation. Account for surviving children. Stop launching more children when the cleanup/inspection budget cannot establish the required bound; do not accumulate executions indefinitely. Require Task 20's disjoint prefixes and persisted job mode. Keep distributed deployment disabled until Task 24 is complete.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Cover crashes before receiving a start response, ambiguous starts, duplicate SQS delivery, child failures, Describe failures, parent SIGTERM, and lease expiry with fake/integration tests.
- Do not create duplicate executions for one attempt or allow old-attempt completion to finish a new attempt.
- SF SUCCEEDED alone does not authorize acknowledgement. Only successful object/master validation and database completion through the finalizer can reach the existing acknowledgement decision.
- Preserve existing attempt/retry/DLQ rules. COMPLETED redelivery starts neither Step Functions nor FFmpeg.
- Bound polling/deadlines without starving heartbeats, and reject work limits exceeding the SQS visibility lifetime.
- Define and connect the Task 23 finalizer port in tests using controllable fakes that can return success, failure, and ownership-loss outcomes. Do not use an unconditional success-returning TODO stub. Verify that Step Functions SUCCEEDED reaches the finalizer port but does not by itself authorize database completion or SQS acknowledgement. Only a successful finalizer outcome while ownership remains valid may reach the existing acknowledgement decision.

Do not implement Task 24's concrete publication/finalization behavior in these fakes. Keep real deployments on cli mode until Task 24 provides the concrete distributed finalizer and publication path.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
python app/scripts/validate_contracts.py
```

**Live acceptance:** Offline/component checks establish implementation completion for this task. Dependent integration validation establishes actual AWS behavior; never report unexecuted live checks as successful.
