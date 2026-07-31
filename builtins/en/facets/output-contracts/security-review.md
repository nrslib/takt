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

## Current Iteration Findings (new)
| # | finding_id | family_tag | Severity | Type | Location | Issue | Fix Suggestion |
|---|------------|------------|----------|------|----------|-------|----------------|
| 1 | SEC-NEW-src-db-L42 | injection-risk | High | SQLi | `src/db.ts:42` | Raw query string | Use parameterized queries |

## Carry-over Findings (persists)
| # | finding_id | family_tag | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|------------|-------------------|------------------|-------|----------------|
| 1 | SEC-PERSIST-src-auth-L18 | injection-risk | `src/auth.ts:18` | `src/auth.ts:18` | Weak validation persists | Harden validation |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| SEC-RESOLVED-src-db-L10 | `src/db.ts:10` now uses bound parameters |

## Reopened Findings (reopened)
| # | finding_id | family_tag | Prior Resolution Evidence | Recurrence Evidence | Issue | Fix Suggestion |
|---|------------|------------|--------------------------|---------------------|-------|----------------|
| 1 | SEC-REOPENED-src-auth-L55 | injection-risk | `Previously fixed at src/auth.ts:20` | `Recurred at src/auth.ts:55` | Issue description | Fix approach |

## Verification Evidence
- Build: {Verified target, what was checked, and observed result; or state that it was unverified}
- Tests: {Verified target, what was checked, and observed result; or state that it was unverified}
- Functional check: {Verified target, what was checked, and observed result; or state that it was unverified}

## Warnings (non-blocking)
- {Security recommendations}

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new`, `persists`, or `reopened`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Checklist only (10 lines or fewer)
- Warnings only → + Warnings in 1-2 lines (15 lines or fewer)
- Vulnerabilities found → include every verified finding in tables and aggregate locations with the same cause
