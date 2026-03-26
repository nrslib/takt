```markdown
# Testing Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

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

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Fix Suggestion |
|---|------------|------------|----------|----------|-------|----------------|
| 1 | TEST-NEW-src-test-L42 | test-structure | Coverage | `src/test.ts:42` | Issue description | Fix suggestion |

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

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE: Summary only (5 lines or fewer)
- REJECT: Only relevant findings in tables (30 lines or fewer)
