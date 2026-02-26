# Terraform Policy

Prioritize safety and maintainability. Write infrastructure code following consistent conventions.

## Principles

| Principle | Criteria |
|-----------|----------|
| Security by Default | Security is strict by default. Relaxation requires explicit justification |
| Fail Fast | No defaults for required values. Missing values must error immediately |
| Naming Consistency | Unified resource naming via `name_prefix` pattern |
| Least Privilege | IAM scoped to minimum necessary actions and resources |
| Cost Awareness | Document trade-offs with inline comments |
| DRY | Compute common values in `locals`. Eliminate duplication |
| One File One Concern | Split files by resource category |

## Variable Declarations

| Criteria | Judgment |
|----------|----------|
| Missing `type` | REJECT |
| Missing `description` | REJECT |
| Sensitive value without `sensitive = true` | REJECT |
| Default on environment-dependent value | REJECT |
| Default on constant value (port numbers, etc.) | OK |

```hcl
# REJECT - no type/description
variable "region" {}

# REJECT - sensitive value without sensitive flag
variable "db_password" {
  type = string
}

# OK - constant value with default
variable "container_port" {
  type        = number
  description = "Container port for the application"
  default     = 8080
}
```

## Security

| Criteria | Judgment |
|----------|----------|
| EC2 without IMDSv2 (`http_tokens != "required"`) | REJECT |
| Unencrypted EBS/RDS | REJECT |
| S3 without public access block | REJECT |
| Security group with unnecessary `0.0.0.0/0` | REJECT |
| IAM policy with `*` resource (no valid reason) | REJECT |
| Direct SSH access (when SSM is viable) | REJECT |
| Hardcoded secrets | REJECT |
| Missing `lifecycle { prevent_destroy = true }` on critical data | Warning |

## Naming Convention

| Criteria | Judgment |
|----------|----------|
| `name_prefix` pattern not used | REJECT |
| Resource name missing environment identifier | REJECT |
| Tag names not in PascalCase | Warning |
| Name exceeds AWS character limits | REJECT |

## File Organization

| Criteria | Judgment |
|----------|----------|
| Resource definitions mixed in `main.tf` | REJECT |
| Resources defined in `variables.tf` | REJECT |
| Multiple resource categories in one file | Warning |
| Unused variable / output / data source | REJECT |

## Tag Management

| Criteria | Judgment |
|----------|----------|
| Provider `default_tags` not configured | REJECT |
| Tags duplicated between `default_tags` and individual resources | Warning |
| Missing `ManagedBy = "Terraform"` tag | Warning |

## Cost Management

| Criteria | Judgment |
|----------|----------|
| Cost-impacting choice without documentation | Warning |
| High-cost resource without alternative consideration | Warning |
