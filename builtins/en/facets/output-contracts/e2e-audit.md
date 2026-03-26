```markdown
# E2E Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Summary
{1-3 sentences summarizing the flow coverage situation}

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {how you confirmed the full flow set was audited}

## Scope
| # | Area | Route / Entry | Existing Scenarios | Coverage Status | Risk |
|---|------|---------------|--------------------|-----------------|------|
| 1 | {feature area} | {route or entry point} | {existing test names} | Covered / Partial / Missing | High / Medium / Low |

## Findings
| # | Priority | Area | Location | Gap | Recommended Action |
|---|----------|------|----------|-----|--------------------|
| 1 | High / Medium / Low | e2e-testing | `e2e/example.spec.ts` / `src/page.tsx:42` | {missing or weakly tested scenario} | {issue-ready action} |

## No-Issue Areas
- {flows confirmed as adequately covered}

## Suggested Issue Titles
1. {Issue title}
2. {Issue title}

## Notes
- {constraints, assumptions, or audit limits}
- {explicit reasons for any intentionally unaudited item}
```

**Cognitive load reduction rules:**
- APPROVE → Summary + Scope only
- IMPROVE → Include only relevant gaps
- REJECT → Include only blocking or high-priority gaps
