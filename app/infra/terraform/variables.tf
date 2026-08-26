variable "project_name" {
  type        = string
  description = "Logical project name used to compose local runtime identifiers."
  default     = "streaming-video-app"
}

variable "environment" {
  type        = string
  description = "Deployment environment label for future naming."
  default     = "local"
}

variable "aws_region" {
  type        = string
  description = "AWS region for the Phase 1 shared AWS foundation."
  default     = "ap-northeast-1"
}

variable "video_encoding_queue_url" {
  type        = string
  description = "Non-secret SQS queue URL placeholder for the encoding worker."
  default     = "https://sqs.ap-northeast-1.amazonaws.com/123456789012/streaming-video-encoding"
}

variable "video_input_bucket" {
  type        = string
  description = "Logical name for the S3 input bucket used by uploads."
  default     = "streaming-video-input-dev"
}

variable "video_output_bucket" {
  type        = string
  description = "Logical name for the S3 output bucket used by HLS playback."
  default     = "streaming-video-output-dev"
}

variable "frontend_origin" {
  type        = string
  description = "Origin allowed by local browser-facing services."
  default     = "http://localhost:5173"
}

variable "api_base_url" {
  type        = string
  description = "Base URL for the local Go API."
  default     = "http://localhost:8080"
}

variable "ffmpeg_path" {
  type        = string
  description = "FFmpeg executable path used by the Rust worker."
  default     = "/usr/bin/ffmpeg"
}

variable "temporary_directory" {
  type        = string
  description = "Temporary working directory for local API and worker runtime use."
  default     = "/tmp/streaming-video-app"
}
