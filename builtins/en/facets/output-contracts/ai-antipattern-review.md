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
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | AI-NEW-src-file-L23 | hallucination | Hallucinated API | `src/file.ts:23` | Non-existent method | direct_acceptance_criterion_violation | The initial review evidence did not inspect this acceptance criterion | Replace with existing API |

For a follow-up finding, `Authorization Basis` must be exactly `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`; initial review uses `not applicable`. `Reason Absent from Initial Round` is a separate factual explanation for a follow-up finding and is `not applicable` for initial review.

`persists` is limited to an unresolved finding that the latest `review-resolution.md` adjudicates as `actionable`, or that has not yet been adjudicated. A finding adjudicated as `out_of_scope`, `overreach`, `false_positive`, `no_issue_after_verification`, or `duplicate` with its canonical finding consolidated must not appear in `persists`.

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | AI-PERSIST-src-file-L42 | hallucination | `src/file.ts:42` | `src/file.ts:42` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| AI-RESOLVED-src-file-L10 | `src/file.ts:10` no longer contains the issue |

## Findings adjudicated out of scope
| finding_id | Latest Disposition | Adjudication Evidence |
|------------|--------------------|-----------------------|
| {finding_id} | out_of_scope / overreach / false_positive / no_issue_after_verification / duplicate | `review-resolution.md` disposition and evidence |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Immediately Preceding Adjudication | Reopening Basis (a-d) | New Evidence | Issue | Fix Suggestion |
|---|------------|------------|------------------------------------|-----------------------|--------------|-------|----------------|
| 1 | AI-REOPENED-src-file-L55 | hallucination | `review-resolution.md`: previously resolved | d | `Recurred at src/file.ts:55` | Issue description | Fix approach |

`reopened` requires explicitly citing the immediately preceding adjudication and showing one of: (a) requirements or acceptance criteria changed after that adjudication; (b) new concrete evidence satisfies blocking conditions that adjudication found missing; (c) the current code disproves a factual premise of that adjudication; or (d) remediation reintroduced the same issue. Remeasuring the same event, adding samples, or rephrasing severity is not a basis for `reopened`.

## Re-scan Evidence (required from the second review onward)
| Policy/Knowledge section checked | Evidence in the diff (`file:line` or "none") |
|----------------------------------|----------------------------------------------|
| {section name} | {evidence} |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` with a valid `Authorization Basis`, `persists` under its adjudication-bound definition, or `reopened` with a valid basis (a-d)
- Findings adjudicated out of scope do not count toward REJECT
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist + Re-scan Evidence (from the second iteration onward) + Non-Finding Concerns when needed
- Issues found → include every verified finding in the impacted sections and aggregate locations with the same cause
- Include findings adjudicated out of scope whenever the latest resolution contains findings with any of the listed dispositions
