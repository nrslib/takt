```markdown
# Testing Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

For every finding that requests a test, record the observable contract to preserve, the concrete failure path, and evidence that existing tests cannot detect it. Do not record findings whose only purpose is freezing internal structure or duplicating existing verification.

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Test coverage | ✅ | - |
| Test structure (Given-When-Then) | ✅ | - |
| Test naming | ✅ | - |
| Test independence & reproducibility | ✅ | - |
| Mocks & fixtures | ✅ | - |
| Test strategy (unit/integration/E2E) | ✅ | - |
| Contract input location (body/query/path) | ✅ | - |

## Problem-Family Completion Sweep
| family_tag / changed contract | Responsible source | Observable invariant | Added path | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|--------------------|----------------------|------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {single responsibility and source that defines the invariant and guarantees it holds} | {condition to preserve} | {new path checked in this review, or none} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / finding number} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Authorization Basis | Reason Absent from Initial Round | Fix Suggestion |
|---|------------|------------|----------|----------|-------|---------------------|----------------------------------|----------------|
| 1 | TEST-NEW-src-test-L42 | test-structure | Coverage | `src/test.ts:42` | Issue description | remediation_regression | The repair changed this behavior after the initial test review | Fix suggestion |

For a follow-up finding, `Authorization Basis` must be exactly `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`; initial review uses `not applicable`. `Reason Absent from Initial Round` is a separate factual explanation for a follow-up finding and is `not applicable` for initial review.

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | TEST-PERSIST-src-test-L77 | test-structure | `src/test.ts:77` | `src/test.ts:77` | Unresolved | Fix suggestion |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| TEST-RESOLVED-src-test-L10 | `src/test.ts:10` now has sufficient coverage |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | TEST-REOPENED-src-test-L55 | test-structure | `Previously fixed at src/test.ts:10` | `Recurred at src/test.ts:55` | Issue description | Fix approach |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Unverified Scope
| Item | Reason | Impact on Decision |
|------|--------|--------------------|
| {Unverified scope, or "none"} | {Reason it was not verified} | {APPROVE allowed / REJECT reason} |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE with no resolved findings: Summary, unverified scope, and only the checked criteria and verification evidence required for a follow-up review (concisely aggregated)
- APPROVE with resolved findings: Summary, Resolved Findings, unverified scope, and only the checked criteria and verification evidence required for a follow-up review (concisely aggregated)
- REJECT: Include every verified finding in tables and aggregate locations with the same cause
