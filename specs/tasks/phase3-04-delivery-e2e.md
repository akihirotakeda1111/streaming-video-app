---
schema_version: 1
id: phase3-delivery-e2e
title: Phase 3 CloudFront Delivery E2E Regression
status: PENDING
base_branch: dev/phase3
target_branch: feature/phase3-delivery-e2e

allowed_paths:
  - app/frontend/e2e/**
  - app/frontend/playwright.config.ts
  - app/scripts/run_reliability_e2e.py
  - app/scripts/generate_reliability_env.mjs
  - app/scripts/setup_reliability_env.mjs
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

Adapt existing happy-path and reliability E2E coverage to prove both private S3 enforcement and real browser playback through CloudFront.

**Priority:** P0. This Markdown is one Work Unit / Task Spec and contains exactly one task.

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

**Preconditions / Dependencies:** `phase3-playback-cloudfront` (`phase3-03-playback-cloudfront.md`) must be merged into `main` or included through a merged ancestor. Cross-file prerequisites are not resolved by the pipeline's `depends_on`; operators select one Spec at a time in this order. Completion on another branch alone is insufficient.

- Treat the Phase 1 happy path and Phase 2 Reliability E2E as complete; do not reimplement them. Preserve direct S3 upload, ObjectCreated to Standard SQS, five public statuses, atomic lease/attempt semantics, both heartbeats, retry/DLQ, immutable COMPLETED, and all-record acknowledgement.
- Preserve input keys and existing completed-output keys. Only the delivery change and distributed attempt prefixes/internal pointer explicitly defined in Task 01 are permitted deltas.
- Only the current owner may publish the parent manifest last and commit completion before acknowledgement. Child success or SF SUCCEEDED alone does not complete the job.
- Do not infer implementation status from a Spec's PENDING metadata. Verify prerequisite code, merged ancestry, and required evidence on the base branch.
- **Validation environment:** Run from the repository root using the existing WSL/Linux development environment and lockfile-compatible Python/Node/Go/Rust. Execute command lines independently and stop on failure. Offline commands must not modify AWS resources. Newly specified commands/features/stages are implemented by their named owning tasks before use.



# Tasks

## delivery-e2e: Phase 3 CloudFront Delivery E2E Regression

depends_on: []

### Requirement

**Scope / Allowed Changes:** Remove public-S3 hostname assumptions from preflight, HLS object inspection, and network evidence. Use dedicated test IAM for SDK output inspection and require every browser manifest/segment request to use the CloudFront origin. Reuse the Phase 1 `@phase1-pipeline` scenario, all six Phase 2 scenarios, and the existing runner; extend selectors and evidence where necessary. Verify the deployed distribution, OAC, output BPA/policy, and frontend origin in resource preflight. Do not count LocalStack checks or URL-string comparisons as CloudFront E2E success.

**Allowed Changes:** Frontmatter paths are the maximum scope for this requirement, adjacent tests, and named runbooks. A broad glob does not authorize unrelated functionality.

### Acceptance Criteria

**Definition of Done:** Meet the following criteria and Validation/Final Verification, and report rationale, evidence, and any unexecuted live checks.

- Observe source upload, S3 notification, SQS processing, durable COMPLETED, CloudFront manifest/segments, and positive browser media-time advancement.
- Verify CloudFront playback of previously completed Phase 1/2 jobs without moving their objects.
- Test anonymous S3 rejection, CloudFront 200/HTTPS, playlist/TS MIME types, relative references, and CORS for allowed/disallowed origins.
- Test publication after requesting a missing key, repeated requests after warming the cache, and bounded 403/404 persistence. Cache hits are not required while TTL=0.
- Preserve the complete Phase 2 `--full-suite`, including its final browser regression through CloudFront.
- Report offline helper/discovery/type-check results separately from live evidence. Unexecuted checks are not PASS.

### Validation

The following automated commands cover offline/component verification. Database tests without an explicitly configured database do not count as live evidence.

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/run_reliability_e2e.py --check
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage delivery
```

# Final Verification

In addition to Task Validation, verify that the final diff remains within allowed paths and preserves existing reliability assertions.

```text
npm --prefix app/frontend run test:e2e:helpers
npm --prefix app/frontend run test:e2e:type-check
npm --prefix app/frontend run test:e2e -- --list
python app/scripts/run_reliability_e2e.py --check
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage delivery
```

**Live acceptance:** An operator verifies a dedicated disposable environment and fixtures, then runs `python app/scripts/run_reliability_e2e.py --full-suite`. Integrate CloudFront/S3 negative checks into its final delivery verification.
