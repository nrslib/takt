```markdown
# Unit Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Summary
{カバレッジ状況の要約を1-3文}

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {完全な対象集合を監査したとどう確認したか}

## Scope
| # | Production File | Existing Test Files | Audited Behaviors | Coverage Status |
|---|-----------------|---------------------|-------------------|-----------------|
| 1 | `src/file.ts` | `src/__tests__/file.test.ts` | {主要な振る舞い} | Covered / Partial / Missing |

## Findings
| # | Priority | Area | Location | Gap | Recommended Action |
|---|----------|------|----------|-----|--------------------|
| 1 | High / Medium / Low | unit-testing | `src/file.ts:42` | {未カバーまたは弱い検証} | {Issue にできる対応案} |

## No-Issue Areas
- {十分にカバーされていると確認したファイルや振る舞い}

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
