# Terraform AWS Knowledge

## Module Design

Split modules by domain (network, database, application layer). Do not create generic utility modules.

| Criteria | Judgment |
|----------|----------|
| Domain-based module splitting | OK |
| Generic "utils" module | REJECT |
| Unrelated resources mixed in one module | REJECT |
| Implicit inter-module dependencies | REJECT (connect explicitly via outputs→inputs) |

### Inter-Module Dependencies

Pass dependencies explicitly via outputs→inputs. Avoid implicit references (using `data` sources to look up other module resources).

```hcl
# OK - Explicit dependency
module "database" {
  source     = "../../modules/database"
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
}

# NG - Implicit dependency
module "database" {
  source = "../../modules/database"
  # vpc_id not passed; module uses data "aws_vpc" internally
}
```

### Identification Variable Passthrough

Pass identification variables (environment, service name) explicitly from root to child modules. Do not rely on globals or hardcoding.

```hcl
# OK - Explicit passthrough
module "database" {
  environment      = var.environment
  service          = var.service
  application_name = var.application_name
}
```

## Resource Naming Convention

Compute `name_prefix` in `locals` and apply consistently to all resources. Append resource-specific suffixes.

| Criteria | Judgment |
|----------|----------|
| Unified naming with `name_prefix` pattern | OK |
| Inconsistent naming across resources | REJECT |
| Name exceeds AWS character limits | REJECT |
| Tag names not in PascalCase | Warning |

```hcl
# OK - Unified with name_prefix
locals {
  name_prefix = "${var.environment}-${var.service}-${var.application_name}"
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
}

# NG - Inconsistent naming
resource "aws_ecs_cluster" "main" {
  name = "${var.environment}-app-cluster"
}
```

### Character Limit Handling

AWS services have name character limits. Use shortened forms when approaching limits.

| Service | Limit | Example |
|---------|-------|---------|
| Target Group | 32 chars | `${var.environment}-${var.service}-backend-tg` |
| Lambda Function | 64 chars | Full prefix OK |
| S3 Bucket | 63 chars | Full prefix OK |

## Tagging Strategy

Use provider `default_tags` for common tags. No duplicate tagging on individual resources.

| Criteria | Judgment |
|----------|----------|
| Centralized via provider `default_tags` | OK |
| Duplicate tags matching `default_tags` on individual resources | Warning |
| Only `Name` tag added on individual resources | OK |

```hcl
# OK - Centralized, individual gets Name only
provider "aws" {
  default_tags {
    tags = {
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

resource "aws_instance" "main" {
  tags = {
    Name = "${local.name_prefix}-instance"
  }
}

# NG - Duplicates default_tags
resource "aws_instance" "main" {
  tags = {
    Environment = var.environment
    ManagedBy   = "Terraform"
    Name        = "${local.name_prefix}-instance"
  }
}
```

## File Organization Patterns

### Environment Directory Structure

Separate environments into directories, each with independent state management.

```
environments/
├── production/
│   ├── terraform.tf       # Version constraints
│   ├── providers.tf       # Provider config (default_tags)
│   ├── backend.tf         # S3 backend
│   ├── variables.tf       # Environment variables
│   ├── main.tf            # Module invocations
│   └── outputs.tf         # Outputs
└── staging/
    └── ...
```

### Module File Structure

| File | Contents |
|------|----------|
| `main.tf` | `locals` and `data` sources only |
| `variables.tf` | Input variable definitions only (no resources) |
| `outputs.tf` | Output definitions only (no resources) |
| `{resource_type}.tf` | One file per resource category |
| `templates/` | user_data scripts and other templates |

## Security Best Practices

### EC2 Instance Security

| Setting | Recommended | Reason |
|---------|-------------|--------|
| `http_tokens` | `"required"` | Enforce IMDSv2 (SSRF prevention) |
| `http_put_response_hop_limit` | `1` | Prevent container escapes |
| `root_block_device.encrypted` | `true` | Data-at-rest encryption |

### S3 Bucket Security

Block all public access with all four settings. Use OAC (Origin Access Control) for CloudFront distributions.

```hcl
# OK - Complete block
resource "aws_s3_bucket_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

### IAM Design

| Pattern | Recommendation |
|---------|---------------|
| Per-service role separation | Separate execution role (for ECS Agent) and task role (for app) |
| CI/CD authentication | OIDC federation (avoid long-lived credentials) |
| Policy scope | Specify resource ARNs explicitly (avoid `"*"`) |

### Secret Management

| Method | Recommendation |
|--------|---------------|
| SSM Parameter Store (SecureString) | Recommended |
| Secrets Manager | Recommended (when rotation needed) |
| Direct in `.tfvars` | Conditional OK (gitignore required) |
| Hardcoded in `.tf` files | REJECT |

Set SSM Parameter initial values to placeholders and use `lifecycle { ignore_changes = [value] }` to manage outside Terraform.

## Cost Optimization Patterns

Document trade-offs with inline comments for cost-impacting choices.

| Choice | Cost Effect | Trade-off |
|--------|------------|-----------|
| NAT Instance vs NAT Gateway | Instance ~$3-4/mo vs Gateway ~$32/mo | Lower availability and throughput |
| Public subnet placement | No VPC Endpoints needed | Weaker network isolation |
| EC2 + EBS vs RDS | EC2 ~$15-20/mo vs RDS ~$50+/mo | Higher operational burden |

```hcl
# OK - Trade-off documented
# Using t3.nano instead of NAT Gateway (~$3-4/mo vs ~$32/mo)
# Trade-off: single-AZ availability, throughput limits
resource "aws_instance" "nat" {
  instance_type = "t3.nano"
}
```

## Lifecycle Rule Usage

| Rule | Purpose | Target |
|------|---------|--------|
| `prevent_destroy` | Prevent accidental deletion | Databases, EBS volumes |
| `ignore_changes` | Allow external changes | `desired_count` (Auto Scaling), SSM `value` |
| `create_before_destroy` | Prevent downtime | Load balancers, security groups |

```hcl
# OK - Prevent accidental database deletion
resource "aws_instance" "database" {
  lifecycle {
    prevent_destroy = true
  }
}

# OK - Let Auto Scaling manage desired_count
resource "aws_ecs_service" "main" {
  lifecycle {
    ignore_changes = [desired_count]
  }
}
```

## Version Management

| Setting | Recommendation |
|---------|---------------|
| `required_version` | `">= 1.5.0"` or higher (`default_tags` support) |
| Provider version | Pin minor version with `~>` (e.g., `~> 5.80`) |
| State locking | `use_lockfile = true` required |
