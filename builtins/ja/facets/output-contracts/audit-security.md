```markdown
# セキュリティ監査レポート

## 結果: APPROVE / REJECT

## 重大度: None / Low / Medium / High / Critical

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {完全なファイル集合を監査したとどう確認したか}

## 監査対象
| # | ファイル | 監査済み | リスク分類 |
|---|---------|---------|-----------|
| 1 | `src/file.ts` | ✅ | 高 / 中 / 低 |

## 検出された問題
| # | 重大度 | カテゴリ | 場所 | 問題 | 修正案 |
|---|--------|---------|------|------|--------|
| 1 | Critical | injection | `src/file.ts:42` | {問題の説明} | {修正方法} |

## 問題なしのファイル
- {問題が検出されなかったファイルの一覧}

## Suggested Issue Titles
1. {Issue タイトル}
2. {Issue タイトル}

## 推奨事項（非ブロッキング）
- {セキュリティ改善の提案}

## Notes
- {制約、前提、監査限界}
- {意図的に未監査とした項目があれば、その明示的な理由}

## REJECT判定条件
- High または Critical の問題が1件以上ある場合は REJECT
```

**認知負荷軽減ルール:**
- 問題なし → 監査対象テーブルのみ（15行以内）
- Low/Medium のみ → + 問題テーブル（30行以内）
- High/Critical あり → 全セクション出力
