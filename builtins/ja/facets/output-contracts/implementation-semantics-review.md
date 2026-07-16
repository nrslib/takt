```markdown
# 実装意味論レビュー

## 結果: APPROVE / REJECT

## サマリー
{1-2文でレビュー結果を要約}

## 非finding化した懸念
| 項目 | 場所 | 分類 | finding化しない根拠 |
|------|------|------|---------------------|
| {懸念。なければ「なし」} | `src/file.ts:42` | false_positive / overreach / out_of_scope / no_issue_after_verification | {根拠} |

## 今回の指摘（new）
| # | finding_id | family_tag | 重大度 | 場所 | 問題 | 壊れる条件 | 修正案 |
|---|------------|------------|--------|------|------|-----------|--------|
| 1 | SEM-NEW-src-file-L42 | data-structure | High / Medium / Low | `src/file.ts:42` | {問題} | {どんな入力・状態で壊れるか} | {修正案} |

## 継続指摘（persists）
| # | finding_id | family_tag | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|------------|----------|----------|------|--------|
| 1 | SEM-PERSIST-src-file-L77 | derived-state | `src/file.ts:77` | `src/file.ts:77` | {未解消の問題} | {修正案} |

## 解消済み（resolved）
| finding_id | 元の期待結果 | 解消根拠 |
|------------|--------------|----------|
| SEM-RESOLVED-src-file-L10 | {元 finding の受入条件} | `src/file.ts:10` で解消 |

## 再開指摘（reopened）
| # | finding_id | family_tag | 解消根拠（前回） | 再発根拠 | 問題 | 修正案 |
|---|------------|------------|----------------|---------|------|--------|
| 1 | SEM-REOPENED-src-file-L55 | fail-fast | `前回: src/file.ts:10` | `src/file.ts:55` | {再発した問題} | {修正案} |

## 検証証跡
- 差分確認: {確認内容}
- 判定根拠の実在確認: {引用した file:line を実コードで確認した旨}

## 再走査証跡（2回目以降のレビューで必須）
| 照合した Policy/Knowledge の章 | 差分側の根拠（`file:line` または「該当なし」） |
|-------------------------------|---------------------------------------------|
| {章名} | {根拠} |

## REJECT判定条件
- `new`、`persists`、または `reopened` が1件以上ある場合のみ REJECT
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリー + 検証証跡 + 再走査証跡（2回目以降）と、必要な場合のみ非finding化した懸念
- REJECT → 該当指摘のみ表で記載（30行以内）
