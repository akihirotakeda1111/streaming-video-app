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

variable "source_visibility_timeout_seconds" {
  type        = number
  description = "Visibility timeout for source queue messages, in seconds."
  default     = 120
  validation {
    condition     = var.source_visibility_timeout_seconds > 0 && var.source_visibility_timeout_seconds <= 43200
    error_message = "source_visibility_timeout_seconds must be between 1 and 43200."
  }
}

variable "worker_heartbeat_interval_seconds" {
  type        = number
  description = "Worker heartbeat interval, in seconds."
  default     = 30
  validation {
    condition     = var.worker_heartbeat_interval_seconds > 0
    error_message = "worker_heartbeat_interval_seconds must be positive."
  }
}

variable "worker_visibility_extension_seconds" {
  type        = number
  description = "Visibility extension requested by each worker heartbeat, in seconds."
  default     = 120
  validation {
    condition     = var.worker_visibility_extension_seconds > 0 && var.worker_visibility_extension_seconds <= 43200
    error_message = "worker_visibility_extension_seconds must be between 1 and 43200."
  }
}

variable "worker_lease_duration_seconds" {
  type        = number
  description = "Database lease duration used by the worker, in seconds."
  default     = 300
  validation {
    condition     = var.worker_lease_duration_seconds > 0
    error_message = "worker_lease_duration_seconds must be positive."
  }
}

variable "worker_retry_delay_seconds" {
  type        = number
  description = "Maximum per-message retry visibility delay, in seconds."
  default     = 900
  validation {
    condition     = var.worker_retry_delay_seconds > 0 && var.worker_retry_delay_seconds <= 43200
    error_message = "worker_retry_delay_seconds must be between 1 and 43200."
  }
}

variable "worker_maximum_attempts" {
  type        = number
  description = "Maximum worker attempts; MVP safety bound is 1 through 10."
  default     = 5
  validation {
    condition     = var.worker_maximum_attempts >= 1 && var.worker_maximum_attempts <= 10 && var.worker_maximum_attempts == floor(var.worker_maximum_attempts)
    error_message = "worker_maximum_attempts must be a whole number between 1 and 10."
  }
}

variable "queue_max_receive_count" {
  type        = number
  description = "SQS redrive receive count; MVP safety bound is 1 through 10."
  default     = 5
  validation {
    condition     = var.queue_max_receive_count >= 1 && var.queue_max_receive_count <= 10 && var.queue_max_receive_count == floor(var.queue_max_receive_count)
    error_message = "queue_max_receive_count must be a whole number between 1 and 10."
  }
}

variable "source_oldest_message_age_alarm_seconds" {
  type        = number
  description = "Source queue oldest-message alarm threshold, in seconds."
  default     = 900
}

variable "source_visible_messages_alarm_threshold" {
  type        = number
  description = "Source queue visible-message alarm threshold."
  default     = 10
}

variable "dlq_visible_messages_alarm_threshold" {
  type        = number
  description = "DLQ visible-message alarm threshold."
  default     = 1
}
