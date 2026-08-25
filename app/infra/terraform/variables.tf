variable "project_name" {
  type        = string
  description = "Project name used for shared naming and tags."
  default     = "streaming-video-app"
}

variable "environment" {
  type        = string
  description = "Environment label used for shared naming and tags."
  default     = "phase1"
}

variable "aws_region" {
  type        = string
  description = "AWS region for the Phase 1 root configuration."
  default     = "us-east-1"
}

variable "frontend_origin" {
  type        = string
  description = "Explicit browser origin used by Phase 1 CORS rules."
  default     = "http://localhost:5173"
}

variable "api_base_url" {
  type        = string
  description = "Base URL for the locally executed API."
  default     = "http://localhost:8080"
}

variable "video_input_bucket_name" {
  type        = string
  description = "Physical name for the Phase 1 input bucket."
  default     = "streaming-video-input"
}

variable "video_output_bucket_name" {
  type        = string
  description = "Physical name for the Phase 1 output bucket."
  default     = "streaming-video-output"
}

variable "encoding_queue_name" {
  type        = string
  description = "Physical name for the Phase 1 encoding queue."
  default     = "streaming-video-encoding"
}
