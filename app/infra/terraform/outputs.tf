output "name_prefix" {
  description = "Shared naming prefix for future Phase 1 and later Terraform resources."
  value       = local.name_prefix
}

output "phase1_environment_variable_names" {
  description = "Canonical non-secret environment variable names used by the API and worker."
  value       = local.phase1_environment_variable_names
}

output "runtime_configuration" {
  description = "Non-secret runtime values for local development and future Terraform wiring."
  value = {
    api_base_url             = var.api_base_url
    aws_region               = var.aws_region
    ffmpeg_path              = var.ffmpeg_path
    frontend_origin          = var.frontend_origin
    temporary_directory      = var.temporary_directory
    video_encoding_queue_url = var.video_encoding_queue_url
    video_input_bucket       = var.video_input_bucket
    video_output_bucket      = var.video_output_bucket
  }

  precondition {
    condition     = var.video_input_bucket != var.video_output_bucket
    error_message = "video_input_bucket and video_output_bucket must differ to prevent an encoding loop."
  }
}

output "aws_region" {
  description = "Resolved Phase 1 AWS region."
  value       = var.aws_region
}

output "video_input_bucket_name" {
  description = "Resolved Phase 1 input bucket name."
  value       = aws_s3_bucket.video_input.bucket
}

output "video_output_bucket_name" {
  description = "Resolved Phase 1 output bucket name."
  value       = aws_s3_bucket.video_output.bucket
}

output "video_encoding_queue_url" {
  description = "Resolved Phase 1 encoding queue URL."
  value       = aws_sqs_queue.video_encoding.url
}

output "api_local_execution" {
  description = "Non-secret IAM configuration for the local Go API."
  value = {
    policy_arn = aws_iam_policy.api_local_execution.arn
    user_name   = aws_iam_user.api_local_execution.name
  }
}

output "worker_local_execution" {
  description = "Non-secret IAM configuration for the local Rust worker."
  value = {
    policy_arn = aws_iam_policy.worker_local_execution.arn
    user_name   = aws_iam_user.worker_local_execution.name
  }
}
