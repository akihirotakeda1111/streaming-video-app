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
            Next = "GuardDeadline"
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
            Next = "GuardDeadline"
          },
        ]
        Default = "InvalidRenditions"
      }
      InvalidRenditions = {
        Type = "Fail"
        Error = "InvalidRenditions"
        Cause = "Exactly one or two distinct supported renditions are required"
      }
      GuardDeadline = {
        Type = "Choice"
        Choices = [{
          Variable = "$$.State.EnteredTime"
          TimestampLessThanPath = "$.deadline_at"
          Next = "EncodeRenditions"
        }]
        Default = "DeadlineExceeded"
      }
      DeadlineExceeded = {
        Type = "Fail"
        Error = "DeadlineExceeded"
        Cause = "Parent execution deadline has passed"
      }
      EncodeRenditions = {
        Type = "Map"
        ItemsPath = "$.renditions"
        ItemSelector = {
          "video_id.$" = "$.video_id"
          "job_id.$" = "$.job_id"
          "attempt.$" = "$.attempt"
          "execution_id.$" = "$.execution_id"
          "source_key.$" = "$.source_key"
          "output_prefix.$" = "$.output_prefix"
          "deadline_at.$" = "$.deadline_at"
          "rendition.$" = "$$.Map.Item.Value"
        }
        MaxConcurrency = 2
        ResultPath = null
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt = "GuardChildDeadline"
          States = {
            GuardChildDeadline = {
              Type = "Choice"
              Choices = [{
                Variable = "$$.State.EnteredTime"
                TimestampLessThanPath = "$.deadline_at"
                Next = "BuildChildPayload"
              }]
              Default = "ChildDeadlineExceeded"
            }
            ChildDeadlineExceeded = {
              Type = "Fail"
              Error = "DeadlineExceeded"
              Cause = "Parent execution deadline has passed"
            }
            BuildChildPayload = {
              Type = "Pass"
              Parameters = {
                "child_payload" = {
                  "video_id.$" = "$.video_id"
                  "job_id.$" = "$.job_id"
                  "attempt.$" = "$.attempt"
                  "execution_id.$" = "$.execution_id"
                  "rendition.$" = "$.rendition"
                  "source_key.$" = "$.source_key"
                  "output_prefix.$" = "States.Format('{}/{}', $.output_prefix, $.rendition)"
                }
              }
              ResultPath = "$.child"
              Next = "BoundEncoderTimeout"
            }
            BoundEncoderTimeout = {
              Type = "Pass"
              QueryLanguage = "JSONata"
              Output = "{% $merge([$states.input, {'remaining_seconds': $floor(($toMillis($states.input.deadline_at) - $millis()) / 1000)}]) %}"
              Next = "CheckRemainingSeconds"
            }
            CheckRemainingSeconds = {
              Type = "Choice"
              Choices = [{
                Variable = "$.remaining_seconds"
                NumericGreaterThanEquals = 1
                Next = "ApplyEncoderTimeout"
              }]
              Default = "ChildDeadlineExceeded"
            }
            ApplyEncoderTimeout = {
              Type = "Pass"
              QueryLanguage = "JSONata"
              Output = "{% $merge([$states.input, {'task_timeout_seconds': $min([${var.encoder_timeout_seconds}, $states.input.remaining_seconds])}]) %}"
              Next = "RunEncoder"
            }
            RunEncoder = {
              Type = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              TimeoutSecondsPath = "$.task_timeout_seconds"
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
              ResultSelector = {
                "task_arn.$" = "$.TaskArn"
                "stop_code.$" = "$.StopCode"
                "stopped_reason.$" = "$.StoppedReason"
                "name.$" = "$.Containers[0].Name"
                "exit_code.$" = "$.Containers[0].ExitCode"
              }
              ResultPath = "$.encoder_result"
              Catch = [{ ErrorEquals = ["States.ALL"], Next = "EncoderFailed" }]
              Next = "CheckEncoderExit"
            }
            CheckEncoderExit = {
              Type = "Choice"
              Choices = [{
                And = [
                  { Variable = "$.encoder_result.name", StringEquals = "encoder" },
                  { Variable = "$.encoder_result.exit_code", NumericEquals = 0 },
                ]
                Next = "EncoderSucceeded"
              }]
              Default = "EncoderFailed"
            }
            EncoderSucceeded = {
              Type = "Pass"
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
  # ECS DescribeTasks/StopTask require Resource "*" with a cluster condition.
  # EventBridge sync is limited to Step Functions' managed ECS completion rule.
  # RunTask is limited to this cluster and encoder task definition; PassRole is limited
  # to the two fixed roles used by that task definition.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecs:RunTask"], Resource = aws_ecs_task_definition.encoder.arn, Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
    { Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = "*", Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
    { Effect = "Allow", Action = ["events:PutRule", "events:PutTargets", "events:DescribeRule"], Resource = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule" },
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
    { Effect = "Allow", Action = ["states:StartExecution"], Resource = aws_sfn_state_machine.orchestration.arn },
    { Effect = "Allow", Action = ["states:DescribeExecution", "states:StopExecution"], Resource = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:${aws_sfn_state_machine.orchestration.name}:*" },
  ] })
}
