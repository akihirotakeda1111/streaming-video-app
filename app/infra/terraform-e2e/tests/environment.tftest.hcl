mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

# The legacy root owns an embedded provider. Isolate it for wrapper tests;
# foundation.tftest.hcl tests it independently as a root with a mocked provider.
override_module {
  target = module.foundation
  outputs = {
    aws_region               = "ap-northeast-1"
    video_input_bucket_name  = "streaming-video-e2e-check-123456789012-ap-northeast-1-input"
    video_output_bucket_name = "streaming-video-e2e-check-123456789012-ap-northeast-1-output"
    video_encoding_queue_url = "https://sqs.ap-northeast-1.amazonaws.com/123456789012/actual-created-queue"
    api_local_execution      = { user_name = "api-user", policy_arn = "arn:aws:iam::123456789012:policy/api" }
    worker_local_execution   = { user_name = "worker-user", policy_arn = "arn:aws:iam::123456789012:policy/worker" }
    runtime_configuration = {
      worker_heartbeat_interval_seconds   = 30
      worker_visibility_extension_seconds = 120
      worker_lease_duration_seconds       = 300
      worker_retry_delay_seconds          = 900
      worker_maximum_attempts             = 5
      video_encoding_queue_url            = "placeholder-not-to-be-exported"
    }
  }
}

variables {
  aws_account_id = "123456789012"
  aws_region     = "ap-northeast-1"
  instance       = "check"
}

run "dedicated_environment" {
  command = plan
  assert {
    condition     = aws_iam_policy.runner.name == "streaming-video-e2e-check-e2e-runner"
    error_message = "E2E names must never use the ordinary deployment prefix."
  }
  assert {
    condition     = output.compose_environment.VIDEO_ENCODING_QUEUE_URL == "https://sqs.ap-northeast-1.amazonaws.com/123456789012/actual-created-queue"
    error_message = "Compose must use the created queue URL, not the legacy runtime placeholder."
  }
  assert {
    condition     = output.compose_environment.VIDEO_INPUT_BUCKET == "streaming-video-e2e-check-123456789012-ap-northeast-1-input" && output.compose_environment.VIDEO_OUTPUT_BUCKET == "streaming-video-e2e-check-123456789012-ap-northeast-1-output"
    error_message = "Buckets must be distinct and scoped to the E2E instance/account/region."
  }
  assert {
    condition     = output.compose_environment.WORKER_MAXIMUM_ATTEMPTS == tostring(module.foundation.runtime_configuration.worker_maximum_attempts)
    error_message = "Compose and provisioned Worker settings must agree."
  }
}

run "invalid_account" {
  command = plan
  variables {
    aws_account_id = "invalid"
  }
  expect_failures = [var.aws_account_id]
}

run "invalid_instance" {
  command = plan
  variables {
    instance = "../shared"
  }
  expect_failures = [var.instance]
}

run "default_timing" {
  command = plan
  assert {
    condition     = var.timing_profile == "standard" && local.timing.heartbeat == 30 && local.timing.visibility == 120 && local.timing.lease == 300
    error_message = "Default timings must preserve other reliability scenarios."
  }
}

run "lifecycle_timing" {
  command = plan
  variables {
    timing_profile = "lifecycle"
  }
  assert {
    condition     = local.timing.heartbeat == 5 && local.timing.visibility == 30 && local.timing.lease == 30
    error_message = "Lifecycle timings must be explicitly selected and coherent."
  }
}

run "invalid_timing" {
  command = plan
  variables {
    timing_profile = "unknown"
  }
  expect_failures = [var.timing_profile]
}
