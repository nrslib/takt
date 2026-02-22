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

## Current Iteration Findings (new)
| # | finding_id | Scope | Location | Issue | Fix Suggestion |
|---|------------|-------|----------|-------|----------------|
| 1 | ARCH-NEW-src-file-L42 | In-scope | `src/file.ts:42` | Issue description | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|-------------------|------------------|-------|----------------|
| 1 | ARCH-PERSIST-src-file-L77 | `src/file.ts:77` | `src/file.ts:77` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| ARCH-RESOLVED-src-file-L10 | `src/file.ts:10` now satisfies the rule |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include only relevant finding rows (30 lines or fewer)
