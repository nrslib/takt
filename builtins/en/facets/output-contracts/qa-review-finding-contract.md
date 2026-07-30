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

## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally. If the injected instructions require structured output, use that schema as the machine format; if they do not, return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

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
