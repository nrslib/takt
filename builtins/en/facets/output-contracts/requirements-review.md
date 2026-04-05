```markdown
# Requirements Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Requirements Cross-Reference
| # | Requirement (from task) | Status | Evidence (file:line) | Comment |
|---|-------------------------|--------|----------------------|---------|
| 1 | {requirement 1} | Satisfied / Unmet / Unverified | `src/file.ts:42` | {Notes} |

- If a sentence contains multiple conditions, split it into multiple independently verifiable rows
- If even one `Unmet` row exists, REJECT is mandatory
- `Satisfied` without evidence is invalid (must be verified in actual code)
- Do not mark a row `Satisfied` when only part of the cases is covered

## Scope Check
| # | Out-of-scope Change | File | Justification | Comment |
|---|---------------------|------|---------------|---------|
| 1 | {change not in requirements} | `src/file.ts` | Justified / Needs review / Unnecessary | {Reason} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Fix Suggestion |
|---|------------|------------|----------|----------|-------|----------------|
| 1 | REQ-NEW-src-file-L42 | req-gap | Unimplemented | `src/file.ts:42` | Issue description | Fix suggestion |

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | REQ-PERSIST-src-file-L77 | req-gap | `file:line` | `file:line` | Unresolved | Fix suggestion |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| REQ-RESOLVED-src-file-L10 | `file:line` now satisfies the requirement |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | REQ-REOPENED-src-file-L55 | req-gap | `Previously fixed at file:line` | `Recurred at file:line` | Issue description | Fix approach |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE: Summary only (5 lines or fewer)
- REJECT: Only relevant findings in tables (30 lines or fewer)
