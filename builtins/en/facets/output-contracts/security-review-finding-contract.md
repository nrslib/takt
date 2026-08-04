```markdown
# Security Review

## Result: APPROVE / REJECT

## Severity: None / Low / Medium / High / Critical

## Check Results
| Category | Result | Notes |
|----------|--------|-------|
| Injection | ✅ | - |
| Authentication & Authorization | ✅ | - |
| Data Protection | ✅ | - |
| Dependencies | ✅ | - |

## Problem-Family Completion Sweep
| family_tag / changed contract | Invariant or root cause | Definition, production, validation | Consumption, persistence, reinjection | Failure, interruption, retry, resume, parallel, auxiliary entries | Mocks, fixtures, test doubles | Unchecked paths | Result |
|-------------------------------|-------------------------|------------------------------------|---------------------------------------|--------------------------------------------------------------------------|------------------------------|-----------------|--------|
| {problem family or contract reviewed} | {condition to preserve} | {locations checked} | {locations checked} | {paths checked} | {test assets checked} | {none or reason unchecked} | {no issue / Finding Contract claim} |

## Finding Contract Claims
{Describe every observed defect or explicit ledger lifecycle claim here separately. If the injected instructions require structured output, use that schema as the machine format; otherwise return only the Markdown report. Do not use a findings table. If there are no claims, write `None`.}

## Resolution Confirmations
| Ledger Reference | Original Acceptance Criteria | Confirmation Evidence |
|------------------|------------------------------|-----------------------|
| {existing finding} | {expected result} | `file:line` |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Warnings (non-blocking)
- {Security recommendations}

## Rejection Gate
- REJECT is valid only when at least one blocking vulnerability is observed
```

**Cognitive load reduction rules:**
- No issues → Checklist only (10 lines or fewer)
- Warnings only → + Warnings in 1-2 lines (15 lines or fewer)
- Vulnerabilities found → Include every verified vulnerability claim in the active Finding Contract format and aggregate locations with the same cause
