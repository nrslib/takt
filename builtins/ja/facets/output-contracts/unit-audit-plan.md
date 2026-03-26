```markdown
# Unit Test Audit Plan

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Scope notes:
  - {対象 production file と test をどう列挙したか}

## Audit Scope
| # | Production File | Existing Test Files | Audited Behaviors / Branches | Coverage Status |
|---|-----------------|---------------------|------------------------------|-----------------|
| 1 | `src/file.ts` | `src/__tests__/file.test.ts` | {公開API・分岐・例外・境界値} | Covered / Partial / Missing |

## Missing Test Cases
| # | Production File | Behavior / Branch | Priority | Planned Test Location |
|---|-----------------|-------------------|----------|-----------------------|
| 1 | `src/file.ts` | {未カバーの振る舞い} | High / Medium / Low | `src/__tests__/file.test.ts` |

## Audit Order
- {監査順}

## Clarifications / Risks
- {確認事項や制約}
```
