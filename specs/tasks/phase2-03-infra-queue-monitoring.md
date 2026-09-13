---
schema_version: 1
id: phase2-infra-queue-monitoring
title: Phase 2 Queue Reliability and Monitoring Infrastructure
status: PENDING
base_branch: dev/phase2
target_branch: feature/phase2-infra-queue-monitoring

allowed_paths:
  - app/infra/**
  - app/scripts/validate_terraform_contracts.py
  - app/compose.yaml
  - app/.env.example

forbidden_paths:
  - specs/**
  - .agent/**
  - agent/**
  - .github/**
  - app/contracts/**
  - app/scripts/validate_contracts.py
  - app/backend/**
  - app/frontend/**
  - app/docs/**

repair_attempt_limit: 3
review_attempt_limit: 3
---

# Objective

Extend the single Phase 1 Terraform root with the minimum SQS recovery and CloudWatch alarm resources defined by `phase2-reliability-contract` after that Task Spec has been merged into `dev`.

# Non-Goals

- Do not recreate or rename the Phase 1 input/output buckets, source queue, S3 notification, or local API/worker identities.
- Do not add CloudFront/OAC, ECS/Fargate, ECR, ALB, RDS, autoscaling, dashboards, traces, log shipping, Step Functions, EventBridge Pipes, AWS Batch, or a worker-side DLQ consumer.
- Do not add automatic DLQ replay or an alarm action that requires an unspecified notification destination.
- Do not execute Terraform or AWS mutation commands from the Agent pipeline.

# Forbidden Actions

- Do not edit files outside `allowed_paths`.
- Do not change Task Specs, shared contracts, application code, frontend, agent code, GitHub Workflows, or architecture documentation.
- Do not run `terraform fmt`, `terraform init`, `terraform validate`, `terraform plan`, `terraform apply`, or `terraform destroy`.
- Do not grant wildcard IAM permissions, create credentials, or allow the worker to send directly to the DLQ.
- Do not replace SQS redrive with application-managed message copying.
- If `phase2-reliability-contract` is not merged, existing Phase 1 resources cannot be extended in place, or alarm destinations require a human choice, stop and escalate.

# Architecture Invariants

- `phase2-reliability-contract` is a prerequisite and must already be merged into `dev`.
- `app/infra/terraform/` remains the only Terraform root and extends existing resources in place.
- The source remains an SQS Standard queue receiving direct S3 `ObjectCreated:*` notifications with the existing prefix and suffix.
- One DLQ and one source-queue redrive policy provide poison-message isolation after a configurable bounded receive count.
- Source visibility timeout, worker heartbeat interval, visibility extension, lease duration, retry delay ceiling, and maximum attempt settings are explicit and satisfy the contract timing relationships.
- Worker IAM adds only the queue capability required to change visibility; API IAM remains unchanged.
- Monitoring is limited to actionable source backlog/age and DLQ-visible-message alarms without a dashboard or new compute platform.
- Terraform validation remains static and architecture-focused; it does not require fixed `.tf` filenames, resource labels, or exact counts beyond singleton relationships required by this architecture.

# Tasks

## infra-queue-monitoring: Add DLQ, redrive, visibility settings, IAM, and alarms

depends_on: []

### Requirement

Extend the existing queue and worker IAM resources with configurable visibility/retry settings, one DLQ and redrive policy, and the minimum CloudWatch alarms for source queue age/backlog and DLQ depth. Extend the custom Terraform contract validator with a Phase 2 reliability stage that validates relationships and effective permissions without calling Terraform CLI.

### Acceptance Criteria

- The existing source queue gains a configurable visibility timeout and redrive policy targeting one encrypted or SQS-managed-encrypted DLQ.
- `maxReceiveCount` is configurable, bounded to a documented MVP range, and aligned with the worker maximum-attempt setting.
- The worker policy permits `sqs:ChangeMessageVisibility` only on the source queue and does not gain DLQ send, queue purge, or wildcard permissions.
- Non-secret outputs/environment examples expose only values required by the worker and reliability validation; credentials remain absent.
- CloudWatch alarms cover `ApproximateAgeOfOldestMessage`, source `ApproximateNumberOfMessagesVisible`, and DLQ `ApproximateNumberOfMessagesVisible` with configurable thresholds.
- No dashboard, ECS/RDS resource, autoscaling policy, CloudFront/OAC resource, or automatic redrive/replay resource is introduced.
- `--stage reliability` validates the source-to-DLQ relationship, timing constraints, worker visibility permission, encryption, and alarm coverage while retaining Phase 1 safety checks.
- Static validation does not enforce Terraform file names, variable/output naming substrings, or unrelated exact resource counts.

### Validation

```text
python app/scripts/validate_terraform_contracts.py --stage reliability
```

# Final Verification

```text
python app/scripts/validate_contracts.py
python app/scripts/validate_terraform_contracts.py --stage reliability
```
