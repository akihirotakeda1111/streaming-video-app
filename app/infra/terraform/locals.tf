locals {
  name_prefix      = "${var.project_name}-${var.environment}"
  s3_path_wildcard = "*"

  phase1_environment_variable_names = {
    api_base_url             = "API_BASE_URL"
    aws_region               = "AWS_REGION"
    ffmpeg_path              = "FFMPEG_PATH"
    frontend_origin          = "FRONTEND_ORIGIN"
    temporary_directory      = "TMPDIR"
    video_encoding_queue_url = "VIDEO_ENCODING_QUEUE_URL"
    video_input_bucket       = "VIDEO_INPUT_BUCKET"
    video_output_bucket      = "VIDEO_OUTPUT_BUCKET"
    worker_heartbeat_interval_seconds   = "WORKER_HEARTBEAT_INTERVAL_SECONDS"
    worker_visibility_extension_seconds = "WORKER_VISIBILITY_EXTENSION_SECONDS"
    worker_lease_duration_seconds       = "WORKER_LEASE_DURATION_SECONDS"
    worker_retry_delay_seconds          = "WORKER_RETRY_DELAY_SECONDS"
    worker_maximum_attempts             = "WORKER_MAXIMUM_ATTEMPTS"
  }
}
