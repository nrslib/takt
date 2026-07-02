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
| {Concern, or "none"} | `src/file.ts:42` | false_positive / overreach / out_of_scope / no_issue_after_verification | {Evidence} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Fix Suggestion |
|---|------------|------------|----------|----------|-------|----------------|
| 1 | AI-NEW-src-file-L23 | hallucination | Hallucinated API | `src/file.ts:23` | Non-existent method | Replace with existing API |

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

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Summary sentence + checklist + Non-Finding Concerns when needed (12 lines or fewer)
- Issues found → include table rows only for impacted sections (30 lines or fewer)
