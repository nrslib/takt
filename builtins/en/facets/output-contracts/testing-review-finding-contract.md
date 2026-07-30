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

**Cognitive load reduction rules:**
- APPROVE: Summary and unverified scope only (8 lines or fewer)
- REJECT: Include every relevant claim using the active Finding Contract format
