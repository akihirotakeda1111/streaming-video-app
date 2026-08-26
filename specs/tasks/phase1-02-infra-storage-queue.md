---
schema_version: 1
id: phase1-infra-storage-queue
title: Phase 1 S3 and SQS Event Infrastructure
status: PENDING
base_branch: dev
target_branch: feature/phase1-infra-storage-queue

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

Define the Phase 1 S3 input/output buckets, Standard SQS encoding queue, direct S3 event delivery, and browser CORS after `phase1-infra-local-runtime` has been merged into `dev`.

# Non-Goals

- Do not create, rewrite, or extend shared contracts or their examples.
- Do not add API or worker IAM execution identities; they belong to `phase1-infra-iam-outputs`.
- Do not add RDS, ECS/Fargate, ECR, ALB, CloudFront, OAC, a DLQ, redrive policy, retries, leases, visibility-timeout heartbeats, worker autoscaling, Step Functions, EventBridge Pipes, CloudWatch alarms, or custom lifecycle events.
- Do not deploy or modify API, worker, or frontend source code.
- Do not make the input bucket public.
- Do not execute Terraform from the Agent pipeline.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, shared contracts, contract fixtures, Execution State, agent runtime code, GitHub Workflows, or architecture documentation.
- Do not run Terraform CLI commands or AWS CLI mutation commands.
- Do not grant wildcard administrator permissions.
- Do not configure output-bucket events to target the encoding queue.
- Do not configure a second queue producer alongside the input-bucket notification.
- If implementation requirements conflict with an existing contract, stop and escalate instead of editing the contract.

# Architecture Invariants

- `phase1-infra-local-runtime` is a prerequisite and must already be merged into `dev`.
- `app/contracts/openapi/api.yaml`, `app/contracts/domain/job-status.schema.json`, `app/contracts/domain/storage-conventions.md`, and `app/contracts/examples/**` are fixed, read-only inputs.
- `VIDEO_INPUT_BUCKET` and `VIDEO_OUTPUT_BUCKET` resolve to distinct buckets.
- Only the input bucket sends `s3:ObjectCreated:*` notifications to the encoding Standard SQS queue, filtered to `videos/` and `/source.mp4`.
- The input bucket is private and accepts browser uploads through presigned `PUT` requests.
- The output bucket permits unauthenticated browser `GET` and `HEAD` only for Phase 1 HLS objects and has CORS for an explicit frontend origin because Phase 1 has no CloudFront.
- Terraform under `app/infra/terraform/` remains the single AWS infrastructure root.
- Terraform configuration requires human verification before merge.

# Tasks

## storage-queue: Define S3 and SQS event infrastructure

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

# Final Verification

```text
python app/scripts/validate_terraform_contracts.py --stage storage-queue
```
