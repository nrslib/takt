```markdown
# E2E Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Summary
{フローのカバレッジ状況の要約を1-3文}

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {完全な flow 集合を監査したとどう確認したか}

## Scope
| # | Area | Route / Entry | Existing Scenarios | Coverage Status | Risk |
|---|------|---------------|--------------------|-----------------|------|
| 1 | {機能領域} | {ルートまたは入口} | {既存テスト名} | Covered / Partial / Missing | High / Medium / Low |

## Findings
| # | Priority | Area | Location | Gap | Recommended Action |
|---|----------|------|----------|-----|--------------------|
| 1 | High / Medium / Low | e2e-testing | `e2e/example.spec.ts` / `src/page.tsx:42` | {未カバーまたは弱いシナリオ} | {Issue にできる対応案} |

## No-Issue Areas
- {十分にカバーされていると確認したフロー}

## Suggested Issue Titles
1. {Issue タイトル}
2. {Issue タイトル}

## Notes
- {制約、前提、監査限界}
- {意図的に未監査とした項目があれば、その明示的な理由}
```

**認知負荷軽減ルール:**
- APPROVE → Summary と Scope のみ
- IMPROVE → 必要な不足のみ記載
- REJECT → ブロッキングまたは高優先度の不足のみ記載
