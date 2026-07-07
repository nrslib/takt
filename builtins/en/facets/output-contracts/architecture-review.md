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
| # | finding_id | family_tag | Scope | Location | Issue | Fix Suggestion |
|---|------------|------------|-------|----------|-------|----------------|
| 1 | ARCH-NEW-src-file-L42 | design-violation | In-scope | `src/file.ts:42` | Issue description | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | ARCH-PERSIST-src-file-L77 | design-violation | `src/file.ts:77` | `src/file.ts:77` | Still unresolved | Apply prior fix plan |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| ARCH-RESOLVED-src-file-L10 | `src/file.ts:10` now satisfies the rule |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | ARCH-REOPENED-src-file-L55 | design-violation | `Previously fixed at src/file.ts:10` | `Recurred at src/file.ts:55` | Issue description | Fix approach |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Re-scan Evidence (required from the second review onward)
| Policy/Knowledge section checked | Evidence in the diff (`file:line` or "none") |
|----------------------------------|----------------------------------------------|
| {section name} | {evidence} |

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- APPROVE → Summary + Verification Evidence + Re-scan Evidence (from the second iteration onward). Omit everything else
- REJECT → Include only relevant finding rows (30 lines or fewer)
