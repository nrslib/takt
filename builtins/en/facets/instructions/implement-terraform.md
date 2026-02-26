Implement Terraform code according to the plan.
Refer only to files within the Report Directory shown in the Piece Context. Do not search or reference other report directories.

**Important**: After implementation, run the following validations in order:
1. `terraform fmt -check` — fix formatting violations with `terraform fmt` if any
2. `terraform validate` — check for syntax and type errors
3. `terraform plan` — verify changes (no unintended modifications)

**Constraints:**
- Never execute `terraform apply`
- Never write secrets (passwords, tokens) in code
- Do not remove existing `lifecycle { prevent_destroy = true }` without approval
- All new variables must have `type` and `description`

**Scope output contract (create at the start of implementation):**
```markdown
# Change Scope Declaration

## Task
{One-line task summary}

## Planned changes
| Type | File |
|------|------|
| Create | `modules/example/main.tf` |
| Modify | `environments/sandbox/main.tf` |

## Estimated size
Small / Medium / Large

## Impact area
- {Affected modules or resources}
```

**Decisions output contract (at implementation completion, only if decisions were made):**
```markdown
# Decision Log

## 1. {Decision}
- **Context**: {Why the decision was needed}
- **Options considered**: {List of options}
- **Rationale**: {Reason for the choice}
- **Cost impact**: {If applicable}
```

**Required output (include headings)**
## Work results
- {Summary of actions taken}
## Changes made
- {Summary of changes}
## Validation results
- {terraform fmt -check result}
- {terraform validate result}
- {terraform plan summary (resources to add/change/destroy)}
