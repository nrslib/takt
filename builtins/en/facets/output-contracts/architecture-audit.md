```markdown
# Architecture Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {how you confirmed the full module and boundary set was audited}

## Audit Scope
| # | Module / Layer | Audited | Key Files | Boundaries Verified |
|---|----------------|---------|-----------|---------------------|
| 1 | {module or layer} | ✅ | `src/file.ts` | {boundary summary} |

## Findings
| # | Severity | Category | Location | Issue | Recommended Fix |
|---|----------|----------|----------|-------|-----------------|
| 1 | High / Medium / Low | boundary / coupling / wiring / dead-code | `src/file.ts:42` | {issue description} | {fix suggestion} |

## Modules with No Blocking Issues
- {modules audited with no blocking findings}

## Suggested Issue Titles
1. {Issue title}
2. {Issue title}

## Follow-up Notes
- {non-blocking observations or constraints}
- {explicit reasons for any intentionally unaudited item}
```

**Cognitive load reduction rules:**
- APPROVE → Scope table only (15 lines max)
- IMPROVE → Scope table + relevant findings only
- REJECT → Include only blocking findings and impacted modules
