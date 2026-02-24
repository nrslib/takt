```markdown
# Requirements Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Requirements Cross-Reference
| # | Requirement (from PR) | Satisfied | Evidence (file:line) |
|---|----------------------|-----------|----------------------|
| 1 | {requirement 1} | ✅/❌ | `src/file.ts:42` |

- If even one ❌ exists, REJECT is mandatory
- A ✅ without evidence is invalid (must be verified in actual code)

## Scope Check
| # | Out-of-scope Change | File | Justification |
|---|---------------------|------|---------------|
| 1 | {change not in requirements} | `src/file.ts` | Justified/Unnecessary |

## Current Iteration Findings (new)
| # | finding_id | Category | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|-------|----------------|
| 1 | REQ-NEW-src-file-L42 | Unimplemented | `src/file.ts:42` | Issue description | Fix suggestion |

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|-------------------|------------------|-------|----------------|
| 1 | REQ-PERSIST-src-file-L77 | `file:line` | `file:line` | Unresolved | Fix suggestion |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| REQ-RESOLVED-src-file-L10 | `file:line` now satisfies the requirement |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE: Summary only (5 lines or fewer)
- REJECT: Only relevant findings in tables (30 lines or fewer)
