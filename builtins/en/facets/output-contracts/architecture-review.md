```markdown
# Architecture Review

## Result: APPROVE / IMPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
- [x] Structure & design
- [x] Code quality
- [x] Change scope
- [x] Test coverage
- [x] Dead code
- [x] Call chain verification

## Problem-Family Completion Sweep
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Scope | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|-------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | ARCH-NEW-src-file-L42 | design-violation | In-scope | `src/file.ts:42` | Issue description | accepted_family_unvisited_consumer | The initial review evidence did not visit this consumer | Fix approach |

For a follow-up finding, `Authorization Basis` must be exactly `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`; initial review uses `not applicable`. `Reason Absent from Initial Round` is a separate factual explanation for a follow-up finding and is `not applicable` for initial review.

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

`persists` is limited to an unresolved finding that the latest `review-resolution.md` adjudicates as `actionable`, or that has not yet been adjudicated. A finding adjudicated as `out_of_scope`, `overreach`, `false_positive`, `no_issue_after_verification`, or `duplicate` with its canonical finding consolidated must not appear in `persists`.

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | ARCH-PERSIST-src-file-L77 | design-violation | `src/file.ts:77` | `src/file.ts:77` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| ARCH-RESOLVED-src-file-L10 | `src/file.ts:10` now satisfies the rule |

## Findings adjudicated out of scope
| finding_id | Latest Disposition | Adjudication Evidence |
|------------|--------------------|-----------------------|
| {finding_id} | out_of_scope / overreach / false_positive / no_issue_after_verification / duplicate | `review-resolution.md` disposition and evidence |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Immediately Preceding Adjudication | Reopening Basis (a-d) | New Evidence | Issue | Fix Suggestion |
|---|------------|------------|------------------------------------|-----------------------|--------------|-------|----------------|
| 1 | ARCH-REOPENED-src-file-L55 | design-violation | `review-resolution.md`: previously resolved | d | `Recurred at src/file.ts:55` | Issue description | Fix approach |

`reopened` requires explicitly citing the immediately preceding adjudication and showing one of: (a) requirements or acceptance criteria changed after that adjudication; (b) new concrete evidence satisfies blocking conditions that adjudication found missing; (c) the current code disproves a factual premise of that adjudication; or (d) remediation reintroduced the same issue. Remeasuring the same event, adding samples, or rephrasing severity is not a basis for `reopened`.

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

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
- APPROVE → Summary + Verification Evidence + Re-scan Evidence (from the second iteration onward). Omit everything else
- REJECT → Include every verified finding row and aggregate locations with the same cause
- Include findings adjudicated out of scope whenever the latest resolution contains findings with any of the listed dispositions
