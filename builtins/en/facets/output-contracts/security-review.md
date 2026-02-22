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
| # | finding_id | Severity | Type | Location | Issue | Fix Suggestion |
|---|------------|----------|------|----------|-------|----------------|
| 1 | SEC-NEW-src-db-L42 | High | SQLi | `src/db.ts:42` | Raw query string | Use parameterized queries |

## Carry-over Findings (persists)
| # | finding_id | Previous Evidence | Current Evidence | Issue | Fix Suggestion |
|---|------------|-------------------|------------------|-------|----------------|
| 1 | SEC-PERSIST-src-auth-L18 | `src/auth.ts:18` | `src/auth.ts:18` | Weak validation persists | Harden validation |

## Resolved Findings (resolved)
| finding_id | Resolution Evidence |
|------------|---------------------|
| SEC-RESOLVED-src-db-L10 | `src/db.ts:10` now uses bound parameters |

## Warnings (non-blocking)
- {Security recommendations}

## Rejection Gate
- REJECT is valid only when at least one finding exists in `new` or `persists`
- Findings without `finding_id` are invalid
```

**Cognitive load reduction rules:**
- No issues → Checklist only (10 lines or fewer)
- Warnings only → + Warnings in 1-2 lines (15 lines or fewer)
- Vulnerabilities found → + finding tables (30 lines or fewer)
