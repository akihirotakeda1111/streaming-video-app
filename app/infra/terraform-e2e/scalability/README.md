# Scalability E2E Terraform environment

This is an independently selected root for the distributed-enabled Task 90
environment. It reuses the delivery foundation through `module.foundation` and
does not copy ECS, RDS, or Step Functions resources. The unchanged
`app/infra/terraform-compute` root consumes this root's delivery state through
its existing `shared_state_path` input.

Keep all state, plans, backend metadata, provider data, and credentials in a
private operator-selected runtime directory outside the repository. The example
backend files are configuration examples only; replace their absolute paths
with private paths before initialization.
