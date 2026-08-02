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

## Problem-Family Completion Sweep
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Scope | Location | Issue | Fix Suggestion |
|---|------------|------------|-------|----------|-------|----------------|
| 1 | TF-NEW-file-L42 | tf-convention | In-scope | `modules/example/main.tf:42` | Issue description | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | TF-PERSIST-file-L77 | tf-convention | `file.tf:77` | `file.tf:77` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| TF-RESOLVED-file-L10 | `file.tf:10` now satisfies the convention |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | TF-REOPENED-file-L55 | tf-convention | `Previously fixed at file.tf:10` | `Recurred at file.tf:55` | Issue description | Fix approach |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include every verified finding row and aggregate locations with the same cause
