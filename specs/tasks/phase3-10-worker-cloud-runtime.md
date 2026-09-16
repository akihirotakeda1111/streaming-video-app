---
schema_version: 1
id: phase3-worker-cloud-runtime
title: Phase 3 Worker TLS and Safe Horizontal Runtime
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-worker-cloud-runtime

allowed_paths:
  - app/backend/worker/**
  - app/backend/api/internal/config/**
  - app/backend/api/internal/bootstrap/**
  - app/backend/api/cmd/api/**
  - app/backend/api/go.mod
  - app/backend/api/go.sum
  - app/compose.yaml
  - app/.env.example
  - app/docs/runbooks/worker-scaling.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/infra/**
  - app/scripts/validate_terraform_contracts.py

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Prepare application-side TLS, bounded concurrency, ECS protection integration, and shutdown behavior for later Fargate deployment. This task does not modify infrastructure definitions or deploy AWS resources.

**Priority:** P1. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not create or modify Terraform, CloudFormation/CDK, IAM, ECS deployment definitions, or autoscaling configuration. Tasks 11-13 own that work. Local Compose/env examples are application-development configuration only.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validator and component tests. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-delivery-e2e` (`phase3-04-delivery-e2e.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## worker-cloud-runtime: Phase 3 Worker TLS and Safe Horizontal Runtime

depends_on: []

### Requirement

**Scope / Allowed Changes:** Replace the Rust PostgreSQL adapter's fixed NoTls connection with CA- and hostname-verified TLS support. Retain explicit non-TLS local Compose operation; never fall back after a cloud TLS failure. Check TLS configuration propagation through the existing Go API driver. Replace fixed `PHASE1_MAX_CONCURRENCY=2` with bounded configuration retaining the local default, and accept a concurrency value of one for the later Fargate deployment; Task 12 supplies that deployment value. Implement application-side bounds for database connections, FFmpeg threads, source size/duration, temporary-file usage, and wall time. Validate configuration and fail safely on insufficient disk space; do not allocate or resize Fargate CPU, memory, or ephemeral storage here.

Implement and component-test the application adapter that, when later deployed in ECS service mode, acquires task scale-in protection before receiving work and renews it before expiry. Coordinate outstanding receives and active work to avoid protection races. Release protection only with no active work, and stop new receives if protection cannot be acquired. After an empty receive, release protection for a bounded idle interval so idle tasks do not remain continuously protected. Preserve shutdown behavior: stop receiving, cancel heartbeat/FFmpeg work, and join within a bound without acknowledging incomplete messages. Protection does not prevent crashes or forced stops; existing lease expiry and redelivery remain the recovery mechanism.

**Ownership boundary:** Task 10 owns application code, configuration parsing/validation, local Compose examples, component tests, and runtime documentation only. It does not create or change AWS infrastructure definitions, IAM policies/roles, ECS task definitions/services, capacity settings, or autoscaling policies. Do not place infrastructure definitions in application directories to bypass the path restriction.

Task 11 owns the cloud network, database, and API infrastructure. Task 12 owns worker IAM, task definition/service, deployment environment values, CPU/memory/ephemeral-storage allocation, and stopTimeout. Task 13 owns scaling targets/policies, metric wiring, and cooldowns. Document the runtime configuration names, types, units, defaults, valid ranges, local/cloud mode selection, protection integration requirements, credential/CA inputs, and shutdown grace period in `worker-scaling.md` so these tasks consume the implemented interface rather than invent a second one. Document required permissions without creating IAM policy artifacts.

Task 10 must be implementable and verifiable before Tasks 11-13. Exercise ECS integration through a fake/local endpoint and credential-provider boundary. Use dedicated local PostgreSQL for real database tests, including a local TLS configuration; no RDS instance, ECS cluster, task role, or deployed scaling policy is a prerequisite. Local mode must not call ECS protection endpoints. Cloud mode must fail closed if required protection/configuration is unavailable, rather than silently selecting local behavior.

**Allowed Changes:** Limit edits to the listed application files, local Compose/env examples, tests, and runtime documentation. `app/infra/**` and the Terraform validator are explicitly forbidden.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Reject invalid CAs, hostname mismatches, and expired certificates. Permit NoTls only in explicitly local configuration.
- Reuse acquisition/heartbeat tests to show that two or more distinct worker identities produce one valid owner for the same job and increment attempts only on successful acquisition.
- Test concurrency limits, protection renewal/expiry/failure, idle release, SIGTERM, and actual FFmpeg child termination.
- Support the SDK task-role credential provider at the application boundary and test it without a real AWS role. Task 12 creates and attaches the role; this task neither creates IAM resources nor injects static cloud keys.
- Preserve API/local configuration compatibility and existing database transaction/lease predicates.
- Provide the runtime configuration handoff for Tasks 11-13 and show that Task 10 tests do not require those tasks to be deployed. No infrastructure-definition files are changed.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
go test -C app/backend/api ./...
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
cargo test --manifest-path app/backend/worker/Cargo.toml
go test -C app/backend/api ./...
python app/scripts/validate_contracts.py
```

**Local integration acceptance:** Set TEST_DATABASE_URL explicitly for dedicated local PostgreSQL race/lease tests and verify a local TLS database connection. Include valid and invalid TLS cases; skipped database tests are not acceptance evidence. This requires no AWS deployment. Task 11 verifies cloud database/API connectivity, Task 12 verifies actual worker task-role/protection wiring and forced-stop recovery, and Task 13 verifies live scale-in/out behavior.
