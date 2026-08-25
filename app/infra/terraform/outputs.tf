output "aws_region" {
  value       = var.aws_region
  description = "AWS region used by the Phase 1 root configuration."
}

output "frontend_origin" {
  value       = var.frontend_origin
  description = "Explicit browser origin used by Phase 1 CORS rules."
}

output "api_base_url" {
  value       = var.api_base_url
  description = "Base URL for the locally executed API."
}

output "video_input_bucket_name" {
  value       = var.video_input_bucket_name
  description = "Physical name for the Phase 1 input bucket."
}

output "video_output_bucket_name" {
  value       = var.video_output_bucket_name
  description = "Physical name for the Phase 1 output bucket."
}

output "encoding_queue_name" {
  value       = var.encoding_queue_name
  description = "Physical name for the Phase 1 encoding queue."
}

output "name_prefix" {
  value       = local.name_prefix
  description = "Shared name prefix for Phase 1 resources."
}
