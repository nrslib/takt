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

## Observed Findings
| # | family_tag | Category | Severity | Location | Issue | Fix Suggestion |
|---|------------|----------|----------|----------|-------|----------------|
| 1 | test-structure | Coverage | high / medium / low | `src/test.ts:42` | Issue description | Fix suggestion |

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
- REJECT: Only relevant findings in tables (30 lines or fewer)
