```markdown
# QA Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Test coverage | ✅ | - |
| Test quality | ✅ | - |
| Error handling | ✅ | - |
| Documentation | ✅ | - |
| Maintainability | ✅ | - |

## Observed Findings
| # | family_tag | Category | Severity | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|----------|-------|----------------|
| 1 | test-coverage | Testing | high / medium / low | `src/test.ts:42` | Missing negative test | Add failure-path test |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Unverified Scope
| Item | Reason | Impact on Decision |
|------|--------|--------------------|
| {Unverified scope, or "none"} | {Reason it was not verified} | {APPROVE allowed / REJECT reason} |

## Rejection Gate
- REJECT is valid only when at least one blocking finding is observed
```
