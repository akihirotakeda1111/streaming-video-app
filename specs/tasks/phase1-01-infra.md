---
schema_version: 1
id: phase1-infra
title: Phase 1 Minimum AWS and Local Runtime Infrastructure
status: PENDING
base_branch: dev
target_branch: feature/phase1-infra

allowed_paths:
  - app/infra/**
  - app/compose.yaml
  - app/.env.example

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/scripts/validate_terraform_contracts.py
  - app/backend/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Implement the minimum infrastructure required by the already-completed Phase 1 contracts: local PostgreSQL configuration for the API and worker, plus AWS S3 input/output buckets, one Standard SQS queue, direct S3 event delivery, CORS, and least-privilege IAM. The Go API, Rust worker, PostgreSQL, and Vue frontend remain locally executed in Phase 1; ECS/Fargate and RDS are not part of this work unit.

Terraform configuration is implemented by the Agent, but Terraform CLI validation is outside the automated Agent validation boundary for this work unit. Terraform changes require human verification before merge.

# Non-Goals

- Do not create, rewrite, or extend shared contracts or their examples.
- Do not add RDS, ECS/Fargate, ECR, ALB, CloudFront, OAC, a DLQ, redrive policy, retries, leases, visibility-timeout heartbeats, worker autoscaling, Step Functions, EventBridge Pipes, CloudWatch alarms, or custom lifecycle events.
- Do not add multi-region, high-availability, disaster-recovery, or production-hardening resources.
- Do not deploy or modify API, worker, or frontend source code.
- Do not make the input bucket public.
- Do not initialize, validate, plan, apply, destroy, or otherwise execute Terraform from the Agent pipeline.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, shared contracts, contract fixtures, Execution State, agent runtime code, GitHub Workflows, or architecture documentation.
- Do not run Terraform CLI commands, including `terraform init`, `terraform fmt`, `terraform validate`, `terraform plan`, `terraform apply`, `terraform destroy`, `terraform import`, `terraform state`, or `terraform workspace`.
- Do not run AWS CLI mutation commands or otherwise change deployed infrastructure.
- Do not grant wildcard administrator permissions.
- Do not configure output-bucket events to target the encoding queue.
- Do not configure a second queue producer alongside the input-bucket notification.
- If implementation requirements conflict with an existing contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `app/contracts/openapi/api.yaml`, `app/contracts/domain/job-status.schema.json`, `app/contracts/domain/storage-conventions.md`, and `app/contracts/examples/**` are fixed, read-only inputs.
- `VIDEO_INPUT_BUCKET` and `VIDEO_OUTPUT_BUCKET` resolve to distinct buckets.
- Only the input bucket sends `s3:ObjectCreated:*` notifications to the encoding Standard SQS queue, filtered to `videos/` and `/source.mp4`.
- The input bucket is private and accepts browser uploads through presigned `PUT` requests.
- The output bucket permits unauthenticated browser `GET` and `HEAD` only for Phase 1 HLS objects and has CORS for an explicit frontend origin because Phase 1 has no CloudFront.
- PostgreSQL runs locally for Phase 1 and remains the shared source of truth for video and encoding-job metadata.
- Terraform under `app/infra/terraform/` is the single AWS infrastructure root.
- Terraform CLI execution is outside the Agent validation boundary. Terraform configuration requires human verification before merge.
- `app/scripts/validate_terraform_contracts.py` performs static Phase 1 structure, invariant, and dangerous-configuration checks without executing Terraform or contacting AWS.
- Static validation enforces Phase 1 architecture relationships but does not prescribe Terraform filenames, resource or variable names, exact policy-resource counts, or policy decomposition.

# Tasks

## local-runtime: Define local PostgreSQL and shared configuration

### Requirement

Define the local PostgreSQL service and non-secret environment-variable template required by the Go API and Rust worker. Create the single Terraform root and its provider, version, variable, local, and output foundations without contacting AWS or changing infrastructure.

### Acceptance Criteria

- `app/compose.yaml` defines a local PostgreSQL service with a health check and persistent development volume.
- `app/.env.example` documents database, AWS region, queue URL, input bucket, output bucket, frontend origin, API base URL, FFmpeg path, and temporary-directory configuration without real credentials.
- API and worker configuration names are consistent with the fixed contracts and directory-structure ADR.
- The local runtime does not introduce RDS, ECS/Fargate, CloudFront, DLQ, Redis, or DynamoDB.
- Terraform configuration is limited to the required Phase 1 foundation and is subject to human Terraform verification before merge.

### Validation

```text
python app/scripts/validate_terraform_contracts.py --stage foundation
```

## storage-queue: Define S3 and SQS event infrastructure

depends_on: local-runtime

### Requirement

Define the two S3 bucket roles, one Standard SQS encoding queue, the queue policy required for the input bucket to publish, and the input-bucket notification filter required by `app/contracts/domain/storage-conventions.md`. Configure input CORS for browser `PUT` and output CORS and read access for direct browser HLS playback.

### Acceptance Criteria

- Input and output buckets are distinct and physical names are configurable per environment.
- The input bucket blocks public access and accepts browser upload only through a presigned request.
- The input bucket sends `s3:ObjectCreated:*` directly to one Standard queue with prefix `videos/` and suffix `/source.mp4`.
- The queue policy restricts S3 publication to the configured input bucket and account.
- The output bucket grants unauthenticated `s3:GetObject` only under `videos/*/jobs/*/hls/*` and grants no public list or write access.
- Output CORS permits `GET` and `HEAD` from the configured frontend origin; input CORS permits the exact presigned upload method and headers.
- No CloudFront, OAC, DLQ, redrive policy, EventBridge route, or output-bucket notification exists.
- Terraform references keep the input notification attached only to the input bucket and keep the two bucket resources distinct.
- Terraform configuration is subject to human Terraform verification before merge.

### Validation

```text
python app/scripts/validate_terraform_contracts.py --stage storage-queue
```

## iam-outputs: Define least-privilege local execution identities and outputs

depends_on: storage-queue

### Requirement

Define least-privilege IAM policies for the locally executed Go API and Rust worker, and expose the non-secret Terraform outputs needed to configure them. Keep credentials outside source control.

### Acceptance Criteria

- The API identity can create presigned `PUT` requests for canonical input-object keys but cannot consume SQS or write HLS output.
- The worker identity can receive and delete queue messages, read canonical input objects, and write canonical HLS output objects but cannot create client upload credentials.
- Queue URL, region, and bucket names are available as non-secret outputs.
- No access key, secret key, database password, or presigned URL is committed.
- API and worker policies are separate resources and contain no administrator policy, unrestricted `s3:*`, or unrestricted `sqs:*` action.
- Terraform configuration is subject to human Terraform verification before merge.

### Validation

```text
python app/scripts/validate_terraform_contracts.py --stage complete
```

# Final Verification

```text
python app/scripts/validate_terraform_contracts.py --stage complete
```
