```markdown
# Unit Test Audit Plan

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Scope notes:
  - {how target production files and tests were enumerated}

## Audit Scope
| # | Production File | Existing Test Files | Audited Behaviors / Branches | Coverage Status |
|---|-----------------|---------------------|------------------------------|-----------------|
| 1 | `src/file.ts` | `src/__tests__/file.test.ts` | {exported APIs, branches, errors, boundaries} | Covered / Partial / Missing |

## Missing Test Cases
| # | Production File | Behavior / Branch | Priority | Planned Test Location |
|---|-----------------|-------------------|----------|-----------------------|
| 1 | `src/file.ts` | {missing behavior} | High / Medium / Low | `src/__tests__/file.test.ts` |

## Audit Order
- {ordered audit plan}

## Clarifications / Risks
- {open questions or constraints}
```
