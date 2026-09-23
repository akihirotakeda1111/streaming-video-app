---
schema_version: 1
id: phase3-cloud-foundation
title: Phase 3 Cloud Database and API Foundation
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-cloud-foundation

allowed_paths:
  - app/infra/terraform-compute/**
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/cloud-runtime.md
  - app/backend/api/Dockerfile

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define the smallest cloud validation foundation with private PostgreSQL and the existing API connected to the same database that Fargate workers will use.

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
- If ACM/DNS, database secrets, or dedicated-environment values are missing, stop live acceptance and report IaC/offline completion separately. Do not substitute disabled certificate verification or a public database.

# Architecture Invariants

**Preconditions / Dependencies:** `phase3-worker-cloud-runtime` (`phase3-10-worker-cloud-runtime.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## cloud-foundation: Phase 3 Cloud Database and API Foundation

depends_on: []

### Requirement

**Validation ownership:** Use the existing Terraform contract validator for foundation checks and existing infrastructure tests where applicable. Do not introduce a separate validator test suite or move negative-fixture self-tests into the validator.

**Runtime handoff:** Consume the TLS/credential configuration and validation behavior implemented by Task 10. This task owns cloud database/network/API provisioning and API deployment values, not a second TLS implementation. Task 10 completion requires local/component verification only; it must not wait for this environment. Reserve shared worker network/security-group interfaces for Task 12. Do not add the worker service or its autoscaling policy here.

**Scope / Allowed Changes:** Add `app/infra/terraform-compute/` for VPC/subnets/security groups, Single-AZ RDS PostgreSQL, ECS cluster, API ECR/task definition/service, HTTPS ALB, log groups, a one-off migration task, and task/execution roles. Consume explicit outputs from the existing S3/SQS/CloudFront root without recreating those resources. Separate state ownership and keep backend examples free of secrets.

For this personal MVP, place API/worker tasks in public subnets with public IPs for outbound AWS API/ECR access, and close worker ingress. Keep RDS in a private subnet group with `publicly_accessible=false`; permit port 5432 only from API/worker security groups. Do not require an always-on NAT Gateway. Document this network choice and its cost/limitations. Use an operator-supplied ACM certificate for ALB HTTPS and preserve CORS for the actual frontend origin. Domain/certificate issuance and frontend hosting are out of scope; operators configure DNS.

Use a service-managed secret for RDS administration instead of a plaintext Terraform password. Apply the existing schema through migration/bootstrap and document how operators populate application secrets. Do not pass administrator credentials to API/worker tasks or expose database URLs/secrets in outputs or logs. Run migration once before starting application tasks.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Define private RDS, restricted ingress, TLS connectivity, and application of existing migrations 0001/0002. Wire the API to Task 10's existing runtime settings and verify actual cloud TLS connectivity without reimplementing application TLS.
- Reuse the API image/code and configure health, upload presigning, and CloudFront playback against the same database.
- Restrict the API role to existing presigned-upload responsibilities; separate ECR/log/secret execution-role permissions.
- Accept image digests or immutable tags and verify image existence before deployment; a missing image cannot count as service readiness.
- Document deployment, cross-root outputs, bootstrap, certificates/DNS, browser origin, budget limits, and shutdown. Do not assume RDS or ALB already exists.
- Implement `--stage compute` to check this foundation plus delivery/reliability, without unconditionally allowing unknown resources.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
python app/scripts/validate_terraform_contracts.py --stage compute
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
python app/scripts/validate_terraform_contracts.py --stage compute
python app/scripts/validate_contracts.py
```

**Live acceptance:** An operator supplies certificates, budget, dedicated account/region, images, and secrets, then reviews and deploys the IaC. Observe API HTTPS reachability, database TLS, schema, and health. Do not migrate local data without explicit direction.
