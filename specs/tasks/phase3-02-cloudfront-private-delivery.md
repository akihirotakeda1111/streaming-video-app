---
schema_version: 1
id: phase3-cloudfront-private-delivery
title: Phase 3 CloudFront OAC and Private Output S3
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-cloudfront-private-delivery

allowed_paths:
  - app/infra/terraform/**
  - app/infra/terraform-e2e/**
  - app/scripts/validate_terraform_contracts.py
  - app/docs/runbooks/cloudfront-delivery.md

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Define CloudFront and OAC delivery from the existing output bucket, remove direct public S3 access, and document a staged cutover without replacing the bucket.

**Priority:** P0. This Markdown is one Work Unit / Task Spec and contains exactly one task.

# Non-Goals

- **Out of Scope:** Reimplementing Phase 1/2, exposing attempt/lease fields publicly, replacing the queue platform, EKS/Kubernetes, GPU clusters, multi-region DR, and unnecessary service decomposition.
- Random S3 hash-prefix sharding, multipart upload for small HLS segments, segment-level massive parallelism, Distributed Map, AWS Batch, and Lambda as the long-running encoder.
- Do not implement another task's work early. Only Task 99 may implement FFmpeg C API work. Viewer authentication, signed URLs/cookies, DRM, frontend hosting, and custom-domain issuance are outside scope.


# Forbidden Actions

- Do not edit outside `allowed_paths` or modify `specs/**`, `.agent/**`, `agent/**`, or `.github/**` from an implementation task. Do not widen Runtime Edit Policy.
- Do not automatically commit/push/merge, rewrite history, apply/destroy Terraform, purge queues, delete shared data, or hard-code/log secrets. Operators perform documented live environment changes and acceptance runs.
- Do not add `terraform fmt -check`, `terraform init -backend=false`, or `terraform validate` to Validation. Use the existing Python static validators. Static success is not provider or live-environment validation.
- **Stop conditions:** Stop and report evidence when prerequisite implementation is absent from the base branch, Task 01's contract conflicts, changes outside scope are needed, or required environment/permissions are unavailable. Do not manufacture success through skips, placeholders, or removed assertions.


# Architecture Invariants

**Preconditions / Dependencies:** `phase3-scalability-contract` (`phase3-01-scalability-contract.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## cloudfront-private-delivery: Phase 3 CloudFront OAC and Private Output S3

depends_on: []

### Requirement

**Scope / Allowed Changes:** Replace the existing public output policy with an OAC policy in the current Terraform root. Add the distribution, OAC, cache/response-header policies, and non-secret outputs. Update the dedicated E2E root's module inputs, outputs, and existing tests as needed. Do not recreate the buckets.

Enable all four output Block Public Access settings and remove public ACLs and public Allow principals. Grant `cloudfront.amazonaws.com` GetObject only for the HLS prefix, conditioned on the intended distribution's `AWS:SourceArn`. Use SigV4 with signing behavior `always` and a REST origin, not an S3 website endpoint. Preserve input privacy, notifications, queue policy, DLQ, and alarms.

Configure viewer HTTPS, GET/HEAD, and OPTIONS where needed. Apply consistent CORS response headers at CloudFront for actual frontend origins, including cache-hit behavior with multiple origins. Do not allow unapproved origins or describe CORS as authentication. Clarify the remaining purpose of S3 CORS for SDK/read inspection. Start legacy deterministic HLS keys at TTL=0 because retries can overwrite them. Task 24 may cache immutable attempt keys. Minimize 403/404 negative caching and document the applicable service minimums.

Make the static validator phase-aware instead of requiring public S3 or prohibiting all CloudFront resources. Implement `--stage delivery`, retaining queue and reliability checks. Existing default and `--stage reliability` invocations must recognize the contract's delivery version and must not require public output on the updated tree. Do not disable IAM checks globally. Use the existing validator for delivery-contract checks; do not create a separate validator test file or require a positive/negative fixture suite.

**Allowed Changes:** Limit changes to the listed infrastructure files, existing Terraform contract validator, and delivery runbook. Existing infrastructure tests may be updated where necessary; do not create a standalone delivery-validator test file. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Permit CloudFront reads from the same bucket and keys while rejecting anonymous S3 GET/HEAD, listing, writes, and origin reads from another distribution.
- Export the distribution domain/ID and a non-secret `PLAYBACK_BASE_URL` value without changing the meaning of existing outputs.
- The existing Terraform contract validator checks for residual public policies, missing/wrong SourceArn, public input, and excessive read/write grants. Do not enforce exact filenames or resource counts, or require a separate fixture suite.
- Document OAC/distribution preparation, Task 03 API cutover, CloudFront verification, and final public-policy removal/BPA enforcement. Operators own staged deployment; final IaC must not retain a public mode.
- Roll back by repairing API/distribution configuration or postponing cutover, never by reopening private S3.

### Validation

Run the existing static validators from the repository root. Task 04 owns live verification of direct S3 access rejection and CloudFront playback.

```text
python app/scripts/validate_terraform_contracts.py --stage delivery
python app/scripts/validate_contracts.py
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
python app/scripts/validate_terraform_contracts.py --stage delivery
python app/scripts/validate_contracts.py
```

**Live acceptance:** In a dedicated environment, observe anonymous S3 GET/HEAD rejection and successful CloudFront manifest/segment requests. Task 04 owns integrated cutover acceptance; completion of this IaC task alone does not prove the cutover succeeded.
