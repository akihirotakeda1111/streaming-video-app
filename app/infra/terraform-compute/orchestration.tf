locals {
  encoder_task_definition_arn = aws_ecs_task_definition.encoder.arn
  orchestration_definition = jsonencode({
    Comment = "Bounded distributed rendition encoding"
    StartAt = "ValidateRenditions"
    TimeoutSeconds = var.orchestration_timeout_seconds
    States = {
      ValidateRenditions = {
        Type = "Choice"
        Choices = [
          {
            And = [
              { Variable = "$.renditions[0]", IsPresent = true },
              { Variable = "$.renditions[1]", IsPresent = false },
              { Or = [
                { Variable = "$.renditions[0]", StringEquals = "360p" },
                { Variable = "$.renditions[0]", StringEquals = "720p" },
              ] },
            ]
            Next = "EncodeRenditions"
          },
          {
            And = [
              { Variable = "$.renditions[0]", IsPresent = true },
              { Variable = "$.renditions[1]", IsPresent = true },
              { Variable = "$.renditions[2]", IsPresent = false },
              { Or = [
                { And = [
                  { Variable = "$.renditions[0]", StringEquals = "360p" },
                  { Variable = "$.renditions[1]", StringEquals = "720p" },
                ] },
                { And = [
                  { Variable = "$.renditions[0]", StringEquals = "720p" },
                  { Variable = "$.renditions[1]", StringEquals = "360p" },
                ] },
              ] },
            ]
            Next = "EncodeRenditions"
          },
        ]
        Default = "InvalidRenditions"
      }
      InvalidRenditions = {
        Type = "Fail"
        Error = "InvalidRenditions"
        Cause = "Exactly one or two distinct supported renditions are required"
      }
      EncodeRenditions = {
        Type = "Map"
        ItemsPath = "$.renditions"
        MaxConcurrency = 2
        ResultPath = null
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt = "BuildChildPayload"
          States = {
            BuildChildPayload = {
              Type = "Pass"
              Parameters = {
                "child_payload" = {
                  "video_id.$" = "$.video_id"
                  "job_id.$" = "$.job_id"
                  "attempt.$" = "$.attempt"
                  "execution_id.$" = "$.execution_id"
                  "rendition.$" = "$$.Map.Item.Value"
                  "source_key.$" = "$.source_key"
                  "output_prefix.$" = "States.Format('{}/{}', $.output_prefix, $$.Map.Item.Value)"
                }
              }
              ResultPath = "$.child"
              Next = "RunEncoder"
            }
            RunEncoder = {
              Type = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              TimeoutSeconds = var.encoder_timeout_seconds
              Parameters = {
                Cluster = aws_ecs_cluster.main.arn
                TaskDefinition = local.encoder_task_definition_arn
                LaunchType = "FARGATE"
                NetworkConfiguration = {
                  AwsvpcConfiguration = {
                    Subnets = aws_subnet.public[*].id
                    SecurityGroups = [aws_security_group.worker.id]
                    AssignPublicIp = "ENABLED"
                  }
                }
                Overrides = {
                  ContainerOverrides = [{
                    Name = "encoder"
                    Environment = [{
                      Name = "CHILD_PAYLOAD_JSON"
                      "Value.$" = "States.JsonToString($.child.child_payload)"
                    }]
                  }]
                }
              }
              ResultPath = null
              Catch = [{ ErrorEquals = ["States.ALL"], Next = "EncoderFailed" }]
              End = true
            }
            EncoderFailed = {
              Type = "Fail"
              Error = "EncoderFailed"
              Cause = "A rendition encoder task failed"
            }
          }
        }
        Catch = [{ ErrorEquals = ["States.ALL"], Next = "OrchestrationFailed" }]
        End = true
      }
      OrchestrationFailed = {
        Type = "Fail"
        Error = "OrchestrationFailed"
        Cause = "Distributed encoding did not complete"
      }
    }
  })
}

resource "aws_cloudwatch_log_group" "encoder" {
  name              = "/ecs/${local.name}/encoder"
  retention_in_days = 7
}

resource "aws_iam_role" "encoder_execution" {
  name               = "${local.name}-encoder-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "encoder_execution" {
  name = "${local.name}-encoder-execution"
  role = aws_iam_role.encoder_execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.worker.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.encoder.arn}:*" },
  ] })
}

resource "aws_iam_role" "encoder" {
  name               = "${local.name}-encoder-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "encoder" {
  name = "${local.name}-encoder-task"
  role = aws_iam_role.encoder.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "arn:aws:s3:::${local.shared.video_input_bucket_name}/videos/*/jobs/*/source.mp4" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = [
      "arn:aws:s3:::${local.shared.video_output_bucket_name}/videos/*/jobs/*/hls/attempts/*/*/360p/*",
      "arn:aws:s3:::${local.shared.video_output_bucket_name}/videos/*/jobs/*/hls/attempts/*/*/720p/*",
    ] },
  ] })
}

resource "aws_ecs_task_definition" "encoder" {
  family                   = "${local.name}-encoder"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.encoder_cpu
  memory                   = var.encoder_memory
  execution_role_arn       = aws_iam_role.encoder_execution.arn
  task_role_arn            = aws_iam_role.encoder.arn
  ephemeral_storage { size_in_gib = var.worker_ephemeral_storage_gib }
  container_definitions = jsonencode([{
    name       = "encoder"
    image      = local.worker_image
    essential  = true
    stopTimeout = var.worker_stop_timeout_seconds
    entryPoint = ["/bin/sh", "-ec"]
    command    = ["printf '%s' \"$CHILD_PAYLOAD_JSON\" | exec /usr/local/bin/video-worker encode-child -"]
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "VIDEO_INPUT_BUCKET", value = local.shared.video_input_bucket_name },
      { name = "VIDEO_OUTPUT_BUCKET", value = local.shared.video_output_bucket_name },
    ]
    logConfiguration = { logDriver = "awslogs", options = { awslogs-group = aws_cloudwatch_log_group.encoder.name, awslogs-region = var.aws_region, awslogs-stream-prefix = "encoder" } }
  }])
}

resource "aws_iam_role" "orchestration" {
  name               = "${local.name}-orchestration"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "orchestration" {
  name = "${local.name}-orchestration"
  role = aws_iam_role.orchestration.id
  # ECS DescribeTasks/StopTask and EventBridge's managed rule used by optimized
  # ECS sync require Resource "*"; the ECS actions are constrained to this cluster.
  # RunTask is limited to this cluster and encoder task definition; PassRole is limited
  # to the two fixed roles used by that task definition.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecs:RunTask"], Resource = aws_ecs_task_definition.encoder.arn, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
    { Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = "*", Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
    { Effect = "Allow", Action = ["events:PutRule", "events:PutTargets", "events:DescribeRule"], Resource = "*" },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.encoder_execution.arn, aws_iam_role.encoder.arn], Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
  ] })
}

resource "aws_sfn_state_machine" "orchestration" {
  name       = "${local.name}-orchestration"
  role_arn   = aws_iam_role.orchestration.arn
  definition = local.orchestration_definition
}

resource "aws_iam_role_policy" "worker_orchestration" {
  name = "${local.name}-worker-orchestration"
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["states:StartExecution", "states:DescribeExecution", "states:StopExecution"], Resource = aws_sfn_state_machine.orchestration.arn },
  ] })
}
