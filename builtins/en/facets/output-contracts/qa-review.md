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

## Current Iteration Findings (new)
| # | finding_id | Category | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|-------|----------------|
| 1 | QA-NEW-src-test-L42 | Testing | `src/test.ts:42` | Missing negative test | Add failure-path test |

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|-------------------|------------------|-------|----------------|
| 1 | QA-PERSIST-src-test-L77 | `src/test.ts:77` | `src/test.ts:77` | Still flaky | Stabilize assertion & setup |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| QA-RESOLVED-src-test-L10 | `src/test.ts:10` now covers error path |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```
