---
schema_version: 1
id: phase3-fargate-worker-service
title: Phase 3 Fargate Worker Service
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-fargate-worker-service

allowed_paths:
  - app/infra/terraform-compute/**
  - app/backend/worker/Dockerfile
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/cloud-runtime.md
  - app/docs/runbooks/worker-scaling.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Deploy the existing Rust worker as a Fargate service connected to the same SQS queue and database, and establish manual horizontal scaling before autoscaling.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- Do not create test code under `app/scripts/`, including standalone test files or test suites embedded in validators/runners. Preserve functional validators and execution entrypoints.
- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-cloud-foundation` (`phase3-11-cloud-foundation.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## fargate-worker-service: Phase 3 Fargate Worker Service

depends_on: []

### Requirement

**Validation ownership:** Use the existing Terraform contract validator for worker deployment checks and the existing Rust suite for runtime regression. Task 11 does not produce a separate Python test file that this task must reuse.

**Runtime handoff:** Consume Task 10's documented configuration interface and application protection adapter. This task owns the actual worker deployment configuration: set receive concurrency=1, supply TLS/CA/secret and explicit cloud-mode values, create/attach required IAM roles and protection permissions, and connect the supported ECS protection endpoint. Configure CPU, memory, ephemeral-storage allocation, and stopTimeout here. Do not reimplement TLS, concurrency parsing, protection lifecycle, or shutdown logic.

**Scope / Allowed Changes:** Add worker ECR, task definition/service, and IAM to Task 11's cluster/network. Reuse existing responsibilities for queue receive/visibility/delete, input GetObject, and output PutObject; do not move local IAM users/access keys into containers. Separate execution-role secret/log/ECR access, parent application permissions, and future child permissions. Start desired/minimum capacity at one and receive concurrency at one. Bound CPU, memory, ephemeral storage, and stopTimeout, making stopTimeout exceed the implemented shutdown grace period from Task 10 with cleanup margin. The baseline grace period is five seconds; read the completed runtime implementation rather than assuming that value is still fixed.

Implement `--stage workers`, including compute, delivery, and reliability checks. Document image building/digest selection, migration readiness, and switching from the local worker. During overlapping old/new service revisions, the existing lease remains authoritative.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- A manual desired-count change from one to two processes distinct jobs concurrently without creating multiple valid owners for a duplicated job.
- Preserve heartbeat cancellation, lease expiry, reacquisition, manifest-last publication, and DLQ behavior after SIGTERM or a forced stop.
- Send structured logs to CloudWatch and correlate worker/job/attempt/task identifiers without receipt handles, database URLs, or presigned URLs.
- Diagnose connectivity, image pull, TLS/secrets, task roles, protection, and ephemeral-disk exhaustion. Verify the deployed values match Task 10's names/ranges and observe actual protection acquire/renew/release in ECS. Leave autoscaling policy and metric wiring to Task 13.
- Prepare a maximum of four tasks within CPU/memory/database-connection limits without adding a worker ALB target or inbound port.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
python app/scripts/validate_terraform_contracts.py --stage workers
cargo test --manifest-path app/backend/worker/Cargo.toml
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
python app/scripts/validate_terraform_contracts.py --stage workers
cargo test --manifest-path app/backend/worker/Cargo.toml
```

**Live acceptance:** Use a dedicated queue to observe distinct jobs on two workers, duplicate delivery, a processing-time StopTask, and recovery. Task 13 owns the scaling policy.
