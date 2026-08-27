output "agent_report_storage" {
  description = "Non-secret S3 and IAM values used by the agent work-report jobs."
  value = {
    aws_region        = var.aws_region
    bucket_name       = aws_s3_bucket.agent_report.bucket
    download_role_arn = aws_iam_role.agent_report_download.arn
    upload_role_arn   = aws_iam_role.agent_report_upload.arn
  }
}
