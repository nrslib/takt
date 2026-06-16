```markdown
# Pure Review

## Result: APPROVE / REJECT

## Summary
{Summarize in 1-2 sentences whether this change is mergeable quality. If REJECT, mention the largest blocker first}

## Pure Review Check
| # | Area | Status | Evidence (file:line / test / execution evidence) | Comment |
|---|------|--------|--------------------------------------------------|---------|
| 1 | Requirement fulfillment | Satisfied / Unmet / Unverified | `src/file.ts:42` | {Notes} |
| 2 | Existing contract and existing-flow impact | No issue / Issue found / Unverified | `src/file.ts:42` | {Notes} |
| 3 | Tests and verification | Sufficient / Insufficient / Unverified | `npm test` | {Notes} |
| 4 | Out-of-scope changes and scope creep | No issue / Issue found / Unverified | `src/file.ts:42` | {Notes} |
| 5 | Obvious security, data-protection, or operational risk | No issue / Issue found / Unverified | `src/file.ts:42` | {Notes} |

## Requirements Cross-Reference
| # | Requirement (from task) | Original Requirement Source | Status | Evidence (file:line) | Exception / Unverified Evidence |
|---|-------------------------|-----------------------------|--------|----------------------|---------------------------------|
| 1 | {requirement 1} | `order.md:10` | Satisfied / Unmet / Unverified | `src/file.ts:42` | {none / evidence} |

## Out-of-Scope Changes and Existing Impact
| # | Change | File | Judgment | Comment |
|---|--------|------|----------|---------|
| 1 | {out-of-scope change or existing impact} | `src/file.ts` | Justified / Needs review / Unnecessary / Problematic | {Reason} |

## Current Iteration Findings (new)
| # | finding_id | family_tag | Category | Location | Issue | Fix Suggestion |
|---|------------|------------|----------|----------|-------|----------------|
| 1 | PURE-NEW-src-file-L42 | mergeability | Regression / Requirement gap / Missing tests / Contract break / Scope creep | `src/file.ts:42` | Issue description | Fix suggestion |

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | PURE-PERSIST-src-file-L77 | mergeability | `file:line` | `file:line` | Unresolved | Fix suggestion |

## Resolved Findings (resolved)
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| PURE-RESOLVED-src-file-L10 | {Original finding acceptance criteria} | `file:line` resolves the issue |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | PURE-REOPENED-src-file-L55 | mergeability | `Previously fixed at file:line` | `Recurred at file:line` | Issue description | Fix approach |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Rejection Gate
- REJECT if at least one merge-blocking issue exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
- Unverified areas should block merge only when they affect mergeability
```

**Cognitive load reduction rules:**
- APPROVE: Summary + Pure Review Check only (10 lines or fewer)
- REJECT: Prioritize blocker findings (40 lines or fewer)
