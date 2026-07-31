```markdown
# Testing Review

## Result: APPROVE / REJECT

## Summary
{Summarize the result in 1-2 sentences}

## Reviewed Aspects
| Aspect | Result | Notes |
|--------|--------|-------|
| Test coverage | ✅ | - |
| Test structure (Given-When-Then) | ✅ | - |
| Test naming | ✅ | - |
| Test independence & reproducibility | ✅ | - |
| Mocks & fixtures | ✅ | - |
| Test strategy (unit/integration/E2E) | ✅ | - |
| Contract input location (body/query/path) | ✅ | - |

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

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

**Cognitive load reduction rules:**
- APPROVE: Summary and unverified scope only (8 lines or fewer)
- REJECT: Include every verified finding claim using the active Finding Contract format and aggregate locations with the same cause
