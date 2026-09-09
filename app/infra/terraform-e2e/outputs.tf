output "compose_environment" {
  description = "Non-secret settings for app/compose.e2e.yaml. Set Worker credentials separately."
  value = {
    AWS_REGION                          = module.foundation.aws_region
    VIDEO_INPUT_BUCKET                  = module.foundation.video_input_bucket_name
    VIDEO_OUTPUT_BUCKET                 = module.foundation.video_output_bucket_name
    VIDEO_ENCODING_QUEUE_URL            = module.foundation.video_encoding_queue_url
    WORKER_HEARTBEAT_INTERVAL_SECONDS   = tostring(module.foundation.runtime_configuration.worker_heartbeat_interval_seconds)
    WORKER_VISIBILITY_EXTENSION_SECONDS = tostring(module.foundation.runtime_configuration.worker_visibility_extension_seconds)
    WORKER_LEASE_DURATION_SECONDS       = tostring(module.foundation.runtime_configuration.worker_lease_duration_seconds)
    WORKER_RETRY_DELAY_SECONDS          = tostring(module.foundation.runtime_configuration.worker_retry_delay_seconds)
    WORKER_MAXIMUM_ATTEMPTS             = tostring(module.foundation.runtime_configuration.worker_maximum_attempts)
    FRONTEND_ORIGIN                     = var.frontend_origin
  }
}

output "worker_identity" {
  value = module.foundation.worker_local_execution
}

output "api_identity" {
  value = module.foundation.api_local_execution
}

output "runner_policy_arn" {
  description = "Attach manually to the existing host E2E runner principal. Does not grant provisioning access."
  value       = aws_iam_policy.runner.arn
}
