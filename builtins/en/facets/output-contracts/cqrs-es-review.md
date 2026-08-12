```markdown
# CQRS+ES Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Aggregate design | ✅ | - |
| Event design | ✅ | - |
| Command/Query separation | ✅ | - |
| Projections | ✅ | - |
| Eventual consistency | ✅ | - |

## Problem-Family Completion Sweep
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Scope | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|-------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | CQRS-NEW-src-file-L42 | cqrs-violation | In-scope | `src/file.ts:42` | Issue description | remediation_regression | The repair introduced this regression after the initial review | Fix approach |

For a follow-up finding, `Authorization Basis` must be exactly `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`; initial review uses `not applicable`. `Reason Absent from Initial Round` is a separate factual explanation for a follow-up finding and is `not applicable` for initial review.

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | CQRS-PERSIST-src-file-L77 | cqrs-violation | `src/file.ts:77` | `src/file.ts:77` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| CQRS-RESOLVED-src-file-L10 | `src/file.ts:10` now satisfies the rule |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | CQRS-REOPENED-src-file-L55 | cqrs-violation | `Previously fixed at src/file.ts:10` | `Recurred at src/file.ts:55` | Issue description | Fix approach |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE with no resolved findings → Summary and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- APPROVE with resolved findings → Summary, Resolved Findings, and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- REJECT → Include every verified finding row and aggregate locations with the same cause
