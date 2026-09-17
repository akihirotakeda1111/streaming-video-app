locals {
  worker_queue_name = element(split("/", local.shared.video_encoding_queue_url), 4)
}

moved {
  from = aws_appautoscaling_target.worker
  to   = aws_appautoscaling_target.worker[0]
}

moved {
  from = aws_appautoscaling_policy.worker_backlog_per_task
  to   = aws_appautoscaling_policy.worker_backlog_per_task[0]
}

resource "aws_appautoscaling_target" "worker" {
  count              = var.worker_autoscaling_enabled ? 1 : 0
  max_capacity       = var.worker_autoscaling_max_capacity
  min_capacity       = var.worker_autoscaling_min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
  lifecycle {
    precondition {
      condition     = var.worker_autoscaling_min_capacity <= var.worker_autoscaling_max_capacity
      error_message = "Worker autoscaling minimum must not exceed maximum capacity."
    }
  }
}

resource "aws_appautoscaling_policy" "worker_backlog_per_task" {
  count              = var.worker_autoscaling_enabled ? 1 : 0
  name               = "${local.name}-worker-backlog-per-task"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker[0].resource_id
  scalable_dimension = aws_appautoscaling_target.worker[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.worker_acceptable_queue_delay_seconds / var.worker_representative_processing_seconds
    scale_out_cooldown = var.worker_scale_out_cooldown_seconds
    scale_in_cooldown  = var.worker_scale_in_cooldown_seconds

    customized_metric_specification {
      metrics {
        id          = "visible_backlog"
        return_data = false
        metric_stat {
          stat = "Sum"
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"
            dimensions {
              name  = "QueueName"
              value = local.worker_queue_name
            }
          }
        }
      }

      metrics {
        id          = "running_tasks"
        return_data = false
        metric_stat {
          stat = "Average"
          metric {
            namespace   = "ECS/ContainerInsights"
            metric_name = "RunningTaskCount"
            dimensions {
              name  = "ClusterName"
              value = aws_ecs_cluster.main.name
            }
            dimensions {
              name  = "ServiceName"
              value = aws_ecs_service.worker.name
            }
          }
        }
      }

      metrics {
        id          = "backlog_per_worker"
        label       = "Visible backlog per running worker"
        expression  = "visible_backlog / running_tasks"
        return_data = true
      }
    }
  }
}

# Target tracking metric math uses the Application Auto Scaling API's fixed
# one-minute sampling. Keep an equivalent diagnostic query explicit so metric
# gaps, zero RunningTaskCount, and queue attributes can be compared directly.
resource "aws_cloudwatch_metric_alarm" "worker_backlog_per_task_diagnostic" {
  alarm_name          = "${local.name}-worker-backlog-per-task-diagnostic"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  threshold           = var.worker_acceptable_queue_delay_seconds / var.worker_representative_processing_seconds
  treat_missing_data  = "missing"
  alarm_description   = "Diagnostic only; inspect missing task metrics before changing worker capacity."

  metric_query {
    id          = "visible_backlog"
    return_data = false
    metric {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      period      = 60
      stat        = "Sum"
      dimensions  = { QueueName = local.worker_queue_name }
    }
  }

  metric_query {
    id          = "running_tasks"
    return_data = false
    metric {
      metric_name = "RunningTaskCount"
      namespace   = "ECS/ContainerInsights"
      period      = 60
      stat        = "Average"
      dimensions = {
        ClusterName = aws_ecs_cluster.main.name
        ServiceName = aws_ecs_service.worker.name
      }
    }
  }

  metric_query {
    id          = "backlog_per_worker"
    expression  = "visible_backlog / running_tasks"
    label       = "Visible backlog per running worker"
    return_data = true
  }
}
