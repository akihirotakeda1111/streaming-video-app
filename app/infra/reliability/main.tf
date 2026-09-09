terraform {
  required_version = ">= 1.6.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "account" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account))
    error_message = "Specify the expected AWS account ID."
  }
}
variable "region" { type = string }
variable "scope" {
  type = string
  validation {
    condition     = can(regex("^sv-e2e-[a-f0-9]{16}$", var.scope))
    error_message = "Use the generated disposable scope."
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account]
  default_tags {
    tags = { "com.streaming-video.e2e.scope" = var.scope, "com.streaming-video.e2e.disposable" = "true" }
  }
}

# This root has its own local state. It does not import or reference app resources.
resource "aws_s3_bucket" "media" {
  for_each      = toset(["input", "output"])
  bucket        = "${var.scope}-${var.account}-${each.key}"
  force_destroy = true # Only explicit teardown of this disposable root uses this.
}
resource "aws_s3_bucket_public_access_block" "media" {
  for_each                = aws_s3_bucket.media
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.scope}-dlq"
  message_retention_seconds = 86400
}
resource "aws_sqs_queue" "source" {
  name                       = "${var.scope}-source"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 86400
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 3 })
}
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url            = aws_sqs_queue.dlq.url
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.source.arn] })
}
resource "aws_sqs_queue_policy" "source" {
  queue_url = aws_sqs_queue.source.url
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sqs:SendMessage",
    Resource = aws_sqs_queue.source.arn,
    Condition = {
      ArnEquals    = { "aws:SourceArn" = aws_s3_bucket.media["input"].arn }
      StringEquals = { "aws:SourceAccount" = var.account }
    }
  }] })
}
resource "aws_s3_bucket_notification" "input" {
  bucket = aws_s3_bucket.media["input"].id
  queue {
    queue_arn     = aws_sqs_queue.source.arn
    events        = ["s3:ObjectCreated:Put"]
    filter_prefix = "videos/"
    filter_suffix = "/source.mp4"
  }
  depends_on = [aws_sqs_queue_policy.source]
}
locals {
  alarms = {
    age     = { queue = aws_sqs_queue.source.name, metric = "ApproximateAgeOfOldestMessage" }
    visible = { queue = aws_sqs_queue.source.name, metric = "ApproximateNumberOfMessagesVisible" }
    dlq     = { queue = aws_sqs_queue.dlq.name, metric = "ApproximateNumberOfMessagesVisible" }
  }
}
resource "aws_cloudwatch_metric_alarm" "queue" {
  for_each            = local.alarms
  alarm_name          = "${var.scope}-${each.key}"
  namespace           = "AWS/SQS"
  metric_name         = each.value.metric
  dimensions          = { QueueName = each.value.queue }
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
}
output "environment" {
  value = {
    E2E_SOURCE_QUEUE      = aws_sqs_queue.source.url
    E2E_DLQ               = aws_sqs_queue.dlq.url
    E2E_SOURCE_BUCKET     = aws_s3_bucket.media["input"].id
    E2E_OUTPUT_BUCKET     = aws_s3_bucket.media["output"].id
    E2E_ALARM_IDENTIFIERS = join(",", [for k in sort(keys(local.alarms)) : aws_cloudwatch_metric_alarm.queue[k].alarm_name])
  }
}
