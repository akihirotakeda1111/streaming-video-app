mock_provider "aws" {
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock-e2e" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

run "fixed_suite_foundation" {
  # Mock apply resolves the DLQ ARN embedded in redrive_policy; no AWS calls.
  command = apply
  module {
    source = "../terraform"
  }
  variables {
    project_name                        = "streaming-video"
    environment                         = "e2e-check"
    aws_region                          = "ap-northeast-1"
    allowed_account_ids                 = ["123456789012"]
    video_input_bucket                  = "streaming-video-e2e-check-input"
    video_output_bucket                 = "streaming-video-e2e-check-output"
    source_visibility_timeout_seconds   = 120
    worker_heartbeat_interval_seconds   = 5
    worker_visibility_extension_seconds = 120
    worker_lease_duration_seconds       = 60
    worker_retry_delay_seconds          = 10
    worker_maximum_attempts             = 3
    queue_max_receive_count             = 3
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.video_encoding.redrive_policy).maxReceiveCount == output.runtime_configuration.worker_maximum_attempts && output.runtime_configuration.worker_maximum_attempts == 3 && output.runtime_configuration.worker_retry_delay_seconds == 10
    error_message = "Worker acquisition and source redrive budgets must agree in the fixed suite configuration."
  }
  assert {
    condition     = aws_sqs_queue.video_encoding.visibility_timeout_seconds == 120 && output.runtime_configuration.worker_visibility_extension_seconds == 120 && output.runtime_configuration.worker_lease_duration_seconds == 60
    error_message = "Queue visibility and Worker lease must use the full-suite settings."
  }
  assert {
    condition     = 2 * output.runtime_configuration.worker_heartbeat_interval_seconds <= min(aws_sqs_queue.video_encoding.visibility_timeout_seconds, output.runtime_configuration.worker_visibility_extension_seconds, output.runtime_configuration.worker_lease_duration_seconds)
    error_message = "Suite timings must retain the heartbeat safety margin."
  }
}

run "foundation_as_root" {
  command = plan
  module {
    source = "../terraform"
  }
  variables {
    project_name        = "streaming-video"
    environment         = "e2e-check"
    aws_region          = "ap-northeast-1"
    allowed_account_ids = ["123456789012"]
    video_input_bucket  = "streaming-video-e2e-check-input"
    video_output_bucket = "streaming-video-e2e-check-output"
  }
  assert {
    condition     = aws_sqs_queue.video_encoding.name == "streaming-video-e2e-check-encoding" && aws_sqs_queue.video_encoding_dlq.name == "streaming-video-e2e-check-encoding-dlq"
    error_message = "Source and DLQ must use the E2E namespace."
  }
  assert {
    condition     = aws_s3_bucket.video_input.bucket != aws_s3_bucket.video_output.bucket && aws_s3_bucket.video_input.force_destroy != true && aws_s3_bucket.video_output.force_destroy != true
    error_message = "Buckets must stay distinct without automatic object destruction."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.video_encoding_oldest_message.dimensions.QueueName == aws_sqs_queue.video_encoding.name && aws_cloudwatch_metric_alarm.video_encoding_dlq_visible_messages.dimensions.QueueName == aws_sqs_queue.video_encoding_dlq.name
    error_message = "Alarms must observe this environment's queues."
  }
}

run "heartbeat_boundary" {
  command = plan
  module {
    source = "../terraform"
  }
  variables {
    worker_heartbeat_interval_seconds   = 60
    worker_lease_duration_seconds       = 120
    worker_visibility_extension_seconds = 120
    source_visibility_timeout_seconds   = 120
  }
}

run "heartbeat_lease_margin" {
  command = plan
  module {
    source = "../terraform"
  }
  variables {
    worker_heartbeat_interval_seconds   = 61
    worker_lease_duration_seconds       = 120
    worker_visibility_extension_seconds = 300
    source_visibility_timeout_seconds   = 300
  }
  expect_failures = [aws_sqs_queue.video_encoding]
}

run "heartbeat_extension_margin" {
  command = plan
  module {
    source = "../terraform"
  }
  variables {
    worker_heartbeat_interval_seconds   = 61
    worker_lease_duration_seconds       = 300
    worker_visibility_extension_seconds = 120
    source_visibility_timeout_seconds   = 300
  }
  expect_failures = [aws_sqs_queue.video_encoding]
}

run "heartbeat_source_margin" {
  command = plan
  module {
    source = "../terraform"
  }
  variables {
    worker_heartbeat_interval_seconds   = 61
    worker_lease_duration_seconds       = 300
    worker_visibility_extension_seconds = 300
    source_visibility_timeout_seconds   = 120
  }
  expect_failures = [aws_sqs_queue.video_encoding]
}

run "heartbeat_near_expiry" {
  command = plan
  module {
    source = "../terraform"
  }
  variables {
    worker_heartbeat_interval_seconds   = 119
    worker_lease_duration_seconds       = 120
    worker_visibility_extension_seconds = 120
    source_visibility_timeout_seconds   = 120
  }
  expect_failures = [aws_sqs_queue.video_encoding]
}
