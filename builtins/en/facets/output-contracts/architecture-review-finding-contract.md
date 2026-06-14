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

## Observed Findings
| # | family_tag | Scope | Severity | Location | Issue | Fix Suggestion |
|---|------------|-------|----------|----------|-------|----------------|
| 1 | design-violation | In-scope | high / medium / low | `src/file.ts:42` | Issue description | Fix approach |

Scope: "In-scope" (fixable in this change) / "Out-of-scope" (existing issue, non-blocking)

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Rejection Gate
- REJECT is valid only when at least one in-scope blocking finding is observed
```

**Cognitive load reduction rules:**
- APPROVE → Summary only (5 lines or fewer)
- REJECT → Include only relevant finding rows (30 lines or fewer)
