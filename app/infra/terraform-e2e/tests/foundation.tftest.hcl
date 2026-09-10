mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
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
