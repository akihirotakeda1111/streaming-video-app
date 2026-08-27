variable "aws_region" {
  type        = string
  description = "AWS region for the agent work-report bucket."
  default     = "ap-northeast-1"
}

variable "github_repository" {
  type        = string
  description = "GitHub repository used to scope work-report S3 object keys."
  default     = "akihirotakeda1111/streaming-video-app"
}

variable "agent_report_retention_days" {
  type        = number
  description = "Number of days to retain agent work reports in S3."
  default     = 1

  validation {
    condition     = var.agent_report_retention_days >= 1
    error_message = "agent_report_retention_days must be at least 1."
  }
}
