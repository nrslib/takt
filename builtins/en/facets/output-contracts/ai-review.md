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

## Current Iteration Findings (new)
| # | finding_id | Category | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|-------|----------------|
| 1 | AI-NEW-src-file-L23 | Hallucinated API | `src/file.ts:23` | Non-existent method | Replace with existing API |

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|-------------------|------------------|-------|----------------|
| 1 | AI-PERSIST-src-file-L42 | `src/file.ts:42` | `src/file.ts:42` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| AI-RESOLVED-src-file-L10 | `src/file.ts:10` no longer contains the issue |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist + empty finding sections (10 lines or fewer)
- Issues found → include table rows only for impacted sections (30 lines or fewer)
