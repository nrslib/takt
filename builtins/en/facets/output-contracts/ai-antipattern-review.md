```markdown
# AI-Generated Code Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in one sentence}

## Verified Items
| Aspect | Result | Notes |
|--------|--------|-------|
| Validity of assumptions | ✅ | - |
| API/library existence | ✅ | - |
| Context fit | ✅ | - |
| Scope | ✅ | - |

## Non-Finding Concerns
| Item | Location | Classification | Evidence for Not Making a Finding |
|------|----------|----------------|-----------------------------------|
| {Concern, or "none"} | `src/file.ts:42` | false_positive / overreach / outside_contract_jurisdiction / no_issue_after_verification | {Evidence} |

## Problem-Family Completion Sweep
| family_tag / changed contract | Responsible source | Observable invariant | Reason to change from the same cause | Added path | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|--------------------|----------------------|--------------------------------------|------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {single responsibility and source that defines the invariant and guarantees it holds} | {condition to preserve} | {why the paths need to change for the same cause} | {new path checked in this review, or none} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | AI-NEW-src-file-L23 | hallucination | Hallucinated API | `src/file.ts:23` | Non-existent method | direct_acceptance_criterion_violation | The initial review evidence did not inspect this acceptance criterion | Replace with existing API |

For a follow-up finding, `Authorization Basis` must be exactly `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`; initial review uses `not applicable`. `Reason Absent from Initial Round` is a separate factual explanation for a follow-up finding and is `not applicable` for initial review.

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | AI-PERSIST-src-file-L42 | hallucination | `src/file.ts:42` | `src/file.ts:42` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| AI-RESOLVED-src-file-L10 | `src/file.ts:10` no longer contains the issue |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | AI-REOPENED-src-file-L55 | hallucination | `Previously fixed at src/file.ts:10` | `Recurred at src/file.ts:55` | Issue description | Fix approach |

## Re-scan Evidence (required from the second review onward)
| Policy/Knowledge section checked | Evidence in the diff (`file:line` or "none") |
|----------------------------------|----------------------------------------------|
| {section name} | {evidence} |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist + Re-scan Evidence (from the second iteration onward) + Non-Finding Concerns when needed
- Issues found → include every verified finding in the impacted sections and aggregate locations with the same cause
