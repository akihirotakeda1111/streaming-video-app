output "environment_identity" {
  description = "Dedicated scalability environment identity."
  value       = "scalability-e2e-${var.instance}"
}

output "runtime_configuration" {
  description = "Non-secret runtime values consumed by terraform-compute."
  value       = module.foundation.runtime_configuration
}

output "aws_region" { value = module.foundation.aws_region }

output "video_input_bucket_name" { value = module.foundation.video_input_bucket_name }
output "video_input_bucket_arn" {
  value = "arn:aws:s3:::${module.foundation.video_input_bucket_name}"
}
output "video_output_bucket_name" { value = module.foundation.video_output_bucket_name }
output "video_output_bucket_arn" {
  value = "arn:aws:s3:::${module.foundation.video_output_bucket_name}"
}
output "video_encoding_queue_url" { value = module.foundation.video_encoding_queue_url }
output "video_encoding_queue_arn" {
  value = "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${element(split("/", module.foundation.video_encoding_queue_url), 4)}"
}
output "cloudfront_distribution_domain_name" {
  value = module.foundation.cloudfront_distribution_domain_name
}
output "cloudfront_distribution_id" { value = module.foundation.cloudfront_distribution_id }
output "playback_base_url" { value = module.foundation.playback_base_url }

output "compute_shared_state_contract" {
  description = "Non-secret values consumed by terraform-compute through shared_state_path."
  value = {
    video_input_bucket_name         = module.foundation.video_input_bucket_name
    video_output_bucket_name        = module.foundation.video_output_bucket_name
    video_encoding_queue_url        = module.foundation.video_encoding_queue_url
    cloudfront_distribution_domain_name = module.foundation.cloudfront_distribution_domain_name
  }
}
