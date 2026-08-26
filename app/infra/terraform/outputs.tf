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
}
