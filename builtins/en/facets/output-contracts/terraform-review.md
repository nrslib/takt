```markdown
# Terraform Convention Review

## Result: APPROVE / REJECT

## Summary
{1-2 sentences summarizing the result}

## Reviewed Aspects
- [x] Variable declarations (type, description, sensitive)
- [x] Resource naming (name_prefix pattern)
- [x] File organization (one file per concern)
- [x] Security configurations
- [x] Tag management
- [x] Lifecycle rules
- [x] Cost trade-off documentation

## New Findings (new)
| # | finding_id | Scope | Location | Issue | Fix Suggestion |
|---|------------|-------|----------|-------|---------------|
| 1 | TF-NEW-file-L42 | In scope | `modules/example/main.tf:42` | Issue description | How to fix |

Scope: "In scope" (fixable now) / "Out of scope" (existing issue, non-blocking)

## Persisting Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|-------------------|------------------|-------|---------------|
| 1 | TF-PERSIST-file-L77 | `file.tf:77` | `file.tf:77` | Unresolved | Apply existing fix plan |

## Resolved
| finding_id | Resolution Evidence |
|------------|-------------------|
| TF-RESOLVED-file-L10 | `file.tf:10` meets conventions |

## REJECT Criteria
- REJECT only if 1+ `new` or `persists` findings exist
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or less)
- REJECT → Only relevant findings in table (30 lines or less)
