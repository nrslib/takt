```markdown
# Frontend Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Component design | ✅ | - |
| State management | ✅ | - |
| Canonical and derived state | ✅ | - |
| Performance | ✅ | - |
| Accessibility | ✅ | - |
| Type safety | ✅ | - |

## Problem-Family Completion Sweep
| family_tag / changed contract | Responsible source | Observable invariant | Reason to change from the same cause | Added path | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|--------------------|----------------------|--------------------------------------|------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {single responsibility and source that defines the invariant and guarantees it holds} | {condition to preserve} | {why the paths need to change for the same cause} | {new path checked in this review, or none} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | FE-NEW-src-file-L42 | component-design | `src/file.tsx:42` | Issue description | required_consumer_migration | The initial review evidence did not inspect this consumer | Fix approach |

For a follow-up finding, `Authorization Basis` must be exactly `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`; initial review uses `not applicable`. `Reason Absent from Initial Round` is a separate factual explanation for a follow-up finding and is `not applicable` for initial review.

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | FE-PERSIST-src-file-L77 | component-design | `src/file.tsx:77` | `src/file.tsx:77` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| FE-RESOLVED-src-file-L10 | `src/file.tsx:10` now satisfies the rule |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | FE-REOPENED-src-file-L55 | component-design | `Previously fixed at src/file.tsx:10` | `Recurred at src/file.tsx:55` | Issue description | Fix approach |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE with no resolved findings → Summary and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- APPROVE with resolved findings → Summary, Resolved Findings, and only the checked criteria and completed-scan evidence required for a follow-up review (concisely aggregated)
- REJECT → Include every verified finding row and aggregate locations with the same cause
