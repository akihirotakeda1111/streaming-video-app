# Scalability E2E Terraform environment

This is an independently selected root for the distributed-enabled Task 90
environment. It reuses the delivery foundation through `module.foundation` and
does not copy ECS, RDS, or Step Functions resources. The unchanged
`app/infra/terraform-compute` root consumes this root's delivery state through
its existing `shared_state_path` input.

Keep all state, plans, backend metadata, provider data, and credentials in a
private operator-selected runtime directory outside the repository. The example
backend files are configuration examples only; replace their absolute paths
with private paths before initialization. The delivery backend path in
`versions.tf` is an unusable sentinel, so init without `-backend-config`
cannot select a state. S3 bucket names use the shorter `sv-scale-e2e-<instance>`
prefix so they stay within 63 characters. The compute dependency lockfile is
committed; compute init must pass `-lockfile=readonly`. See
`app/docs/runbooks/scalability-e2e.md` for ECR bootstrap, the full plan, and
the Task 90 autoscaling handoff.
