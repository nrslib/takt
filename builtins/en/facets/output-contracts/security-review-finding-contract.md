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

## Finding Contract Claims
{When the injected Finding Contract instructions include the canonical block protocol, emit exactly one block per observed defect or explicit ledger lifecycle claim. Otherwise, describe claims here normally and use the required structured output as the sole machine format. Do not use a findings table. If there are no claims, write `None`.}

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
- Warnings only → + concise warnings
- Vulnerabilities found → + every vulnerability in the active Finding Contract format
