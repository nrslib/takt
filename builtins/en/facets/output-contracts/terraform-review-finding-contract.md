```markdown
# Terraform Convention Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
- [x] Variable declarations (type, description, sensitive)
- [x] Resource naming (name_prefix pattern)
- [x] File structure (one concern per file)
- [x] Security settings
- [x] Tag management
- [x] lifecycle rules
- [x] Cost trade-off documentation

## Observed Findings
| # | family_tag | Severity | Scope | Location | Issue | Impact | Fix Suggestion |
|---|------------|----------|-------|----------|-------|--------|----------------|
| 1 | tf-convention | High / Medium / Low | In-scope | `modules/example/main.tf:42` | Issue description | Operations, security, or maintainability impact | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Rejection Gate
- REJECT only when at least one blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include only relevant finding rows (30 lines or fewer)
