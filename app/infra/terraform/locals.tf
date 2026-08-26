locals {
  name_prefix = "${var.project_name}-${var.environment}"
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
  }
}
