```markdown
# Architecture Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {完全な module / boundary 集合を監査したとどう確認したか}

## Audit Scope
| # | Module / Layer | Audited | Key Files | Boundaries Verified |
|---|----------------|---------|-----------|---------------------|
| 1 | {モジュールまたはレイヤー} | ✅ | `src/file.ts` | {境界要約} |

## Findings
| # | Severity | Category | Location | Issue | Recommended Fix |
|---|----------|----------|----------|-------|-----------------|
| 1 | High / Medium / Low | boundary / coupling / wiring / dead-code | `src/file.ts:42` | {問題説明} | {修正案} |

## Modules with No Blocking Issues
- {ブロッキング指摘のない監査済みモジュール}

## Suggested Issue Titles
1. {Issue タイトル}
2. {Issue タイトル}

## Follow-up Notes
- {非ブロッキングの観察事項や制約}
- {意図的に未監査とした項目があれば、その明示的な理由}
```

**認知負荷軽減ルール:**
- APPROVE → スコープ表のみ（15行以内）
- IMPROVE → スコープ表と必要な指摘のみ
- REJECT → ブロッキング指摘と影響モジュールのみ
