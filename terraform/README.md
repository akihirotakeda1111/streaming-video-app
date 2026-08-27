# Agent work-report infrastructure

This Terraform root provisions only the private S3 checkpoint and the
least-privilege IAM users used by `.github/workflows/agent-execute.yml`. It is
independent from the application infrastructure under `app/infra/terraform`.

After applying this root, copy the `agent_report_storage` output into these
GitHub repository variables:

- `AGENT_REPORT_AWS_REGION`
- `AGENT_REPORT_BUCKET`

Terraform creates separate upload and download IAM users but intentionally does
not create their access keys, so secret values are not stored in Terraform
state. Use the `upload_user_name` and `download_user_name` output values to
create access keys in the AWS console, then register them as these GitHub
repository secrets:

- `AGENT_REPORT_UPLOAD_AWS_ACCESS_KEY_ID`
- `AGENT_REPORT_UPLOAD_AWS_SECRET_ACCESS_KEY`
- `AGENT_REPORT_DOWNLOAD_AWS_ACCESS_KEY_ID`
- `AGENT_REPORT_DOWNLOAD_AWS_SECRET_ACCESS_KEY`

The upload user can only put objects below this repository's work-report
prefix. The download user can only get objects from the same prefix.
