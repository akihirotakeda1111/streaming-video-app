# Agent work-report infrastructure

This Terraform root provisions only the private S3 checkpoint and GitHub
Actions OIDC roles used by `.github/workflows/agent-execute.yml`. It is
independent from the application infrastructure under `app/infra/terraform`.

After applying this root, copy the `agent_report_storage` output into these
GitHub repository variables:

- `AGENT_REPORT_AWS_REGION`
- `AGENT_REPORT_BUCKET`
- `AGENT_REPORT_UPLOAD_ROLE_ARN`
- `AGENT_REPORT_DOWNLOAD_ROLE_ARN`

The default OIDC subject allows the `dev` branch of this repository. Override
`github_actions_oidc_subject` when the repository uses GitHub immutable subject
claims. If the AWS account already contains the GitHub Actions OIDC provider,
import it into this Terraform state before applying.
