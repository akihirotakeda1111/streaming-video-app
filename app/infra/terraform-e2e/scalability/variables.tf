variable "aws_account_id" {
  type        = string
  description = "Dedicated AWS account enforced by the provider."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly 12 digits."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-northeast-1"
}

variable "instance" {
  type        = string
  description = "Short ID for this dedicated scalability environment."
  default     = "load"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,10}[a-z0-9]$", var.instance))
    error_message = "instance must be lowercase letters, digits, or hyphens."
  }
}

variable "frontend_origin" {
  type        = string
  description = "Operator-supplied reachable frontend origin; no hosting is created here."
}

variable "frontend_origins" {
  type        = list(string)
  default     = null
  description = "Optional explicit CORS allowlist."
}

variable "source_visibility_timeout_seconds" {
  type    = number
  default = 120
}
variable "worker_heartbeat_interval_seconds" {
  type    = number
  default = 5
}
variable "worker_visibility_extension_seconds" {
  type    = number
  default = 120
}
variable "worker_lease_duration_seconds" {
  type    = number
  default = 60
}
variable "worker_retry_delay_seconds" {
  type    = number
  default = 10
}
variable "worker_maximum_attempts" {
  type    = number
  default = 3
}
variable "queue_max_receive_count" {
  type    = number
  default = 3
}
