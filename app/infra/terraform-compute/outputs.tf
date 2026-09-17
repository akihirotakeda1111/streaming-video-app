output "api_base_url" {
  description = "HTTPS API endpoint behind the ALB."
  value       = "https://${aws_lb.api.dns_name}"
}
output "rds_endpoint" {
  description = "Non-secret RDS endpoint for operator connectivity checks."
  value       = aws_db_instance.postgres.address
}
output "rds_admin_secret_arn" {
  description = "Service-managed RDS administrator secret ARN; never injected into tasks."
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}
output "api_task_definition" { value = aws_ecs_task_definition.api.arn }
output "migration_task_definition" { value = aws_ecs_task_definition.migration.arn }
output "api_image_digest" { value = data.aws_ecr_image.api.image_digest }
