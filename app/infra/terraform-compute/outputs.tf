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
output "api_repository_url" { value = aws_ecr_repository.api.repository_url }
output "ecs_cluster" { value = aws_ecs_cluster.main.name }
output "api_service" { value = aws_ecs_service.api.name }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "api_security_group_id" { value = aws_security_group.api.id }
