```markdown
# Unit Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Summary
{1-3 sentences summarizing the coverage situation}

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {how you confirmed the full target set was audited}

## Scope
| # | Production File | Existing Test Files | Audited Behaviors | Coverage Status |
|---|-----------------|---------------------|-------------------|-----------------|
| 1 | `src/file.ts` | `src/__tests__/file.test.ts` | {key behaviors} | Covered / Partial / Missing |

## Findings
| # | Priority | Area | Location | Gap | Recommended Action |
|---|----------|------|----------|-----|--------------------|
| 1 | High / Medium / Low | unit-testing | `src/file.ts:42` | {missing or weakly tested behavior} | {issue-ready action} |

## No-Issue Areas
- {files or behaviors confirmed as adequately covered}

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
