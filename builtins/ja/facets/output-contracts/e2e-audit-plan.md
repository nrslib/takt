```markdown
# E2E Audit Plan

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Scope notes:
  - {route、flow、E2E spec をどう列挙したか}

## Audited User Flows
| # | Area | Route / Entry | Existing Scenarios | Coverage Status | Risk |
|---|------|---------------|--------------------|-----------------|------|
| 1 | {機能領域} | {ルートまたは入口} | {既存テスト名} | Covered / Partial / Missing | High / Medium / Low |

## Missing Scenarios
| # | Area | Scenario | Priority | Planned Test Location |
|---|------|----------|----------|-----------------------|
| 1 | {機能領域} | {未カバーのシナリオ} | High / Medium / Low | `e2e/example.spec.ts` |

## Audit Order
- {監査順}

## Clarifications / Risks
- {確認事項や制約}
```
