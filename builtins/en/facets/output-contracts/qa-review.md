```markdown
# QA Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Test coverage | ✅ | - |
| Test quality | ✅ | - |
| Error handling | ✅ | - |
| Documentation | ✅ | - |
| Maintainability | ✅ | - |

## Contract Entry Check
Fill this when the diff adds or changes IDs, names, metadata, config, environment variables, or output contracts.

| Entry / Path | Original Requirement | Implementation Evidence | Test Evidence | Judgment | Exception / Unverified Evidence |
|--------------|----------------------|--------------------------|---------------|----------|---------------------------------|
| {normal entry / derived condition / validation / evaluation / output / re-injection, etc.} | {Requirement} | `src/file.ts:42` | `src/file.test.ts:10` | ✅/❌/⚠️ | {none / evidence} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Fix Suggestion |
|---|------------|------------|----------|----------|-------|----------------|
| 1 | QA-NEW-src-test-L42 | test-coverage | Testing | `src/test.ts:42` | Missing negative test | Add failure-path test |

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | QA-PERSIST-src-test-L77 | test-coverage | `src/test.ts:77` | `src/test.ts:77` | Still flaky | Stabilize assertion & setup |

## Resolved Findings (resolved)
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| QA-RESOLVED-src-test-L10 | {Original finding acceptance criteria} | `src/test.ts:10` now covers error path |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | QA-REOPENED-src-test-L55 | test-coverage | `Previously fixed at src/test.ts:10` | `Recurred at src/test.ts:55` | Issue description | Fix approach |

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
