```markdown
# Architecture Audit Plan

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Scope notes:
  - {module、layer、boundary、entry point をどう列挙したか}

## Module Inventory
| # | Module / Layer | Key Files | Responsibility | Main Boundaries | Risk |
|---|----------------|-----------|----------------|-----------------|------|
| 1 | {モジュールまたはレイヤー} | `src/file.ts` | {主責務} | {境界要約} | High / Medium / Low |

## Audit Targets
| # | Module / Layer | What to Verify | Priority |
|---|----------------|----------------|----------|
| 1 | {モジュールまたはレイヤー} | {依存方向・配線・責務・抽象} | High / Medium / Low |

## Audit Order
- {監査順}

## Clarifications / Risks
- {確認事項や制約}
```
