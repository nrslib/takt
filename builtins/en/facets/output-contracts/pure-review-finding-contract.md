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
| # | Requirement (from task) | Status | Evidence (file:line) | Comment |
|---|-------------------------|--------|----------------------|---------|
| 1 | {requirement 1} | Satisfied / Unmet / Unverified | `src/file.ts:42` | {Notes} |

## Out-of-Scope Changes and Existing Impact
| # | Change | File | Judgment | Comment |
|---|--------|------|----------|---------|
| 1 | {out-of-scope change or existing impact} | `src/file.ts` | Justified / Needs review / Unnecessary / Problematic | {Reason} |

## Observed Findings
| # | family_tag | Category | Severity | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|----------|-------|----------------|
| 1 | mergeability | Regression / Requirement gap / Missing tests / Contract break / Scope creep | high / medium / low | `src/file.ts:42` | Issue description | Fix suggestion |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Rejection Gate
- REJECT if at least one merge-blocking finding is observed
- Unverified areas should block merge only when they affect mergeability
```

**Cognitive load reduction rules:**
- APPROVE: Summary + Pure Review Check only (10 lines or fewer)
- REJECT: Prioritize blocker findings (40 lines or fewer)
