```markdown
# コーディングレビュー

## 結果: APPROVE / REJECT

## サマリー
{1-2文でレビュー結果を要約}

## 今回の指摘（new）
| # | finding_id | family_tag | 重大度 | 場所 | 問題 | 影響 | 修正案 |
|---|------------|------------|--------|------|------|------|--------|
| 1 | CODE-NEW-src-file-L42 | bug | High / Medium / Low | `src/file.ts:42` | {問題} | {影響} | {修正案} |

## 継続指摘（persists）
| # | finding_id | family_tag | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|------------|----------|----------|------|--------|
| 1 | CODE-PERSIST-src-file-L77 | regression | `src/file.ts:77` | `src/file.ts:77` | {未解消の問題} | {修正案} |

## 解消済み（resolved）
| finding_id | 解消根拠 |
|------------|----------|
| CODE-RESOLVED-src-file-L10 | `src/file.ts:10` で解消 |

## 再開指摘（reopened）
| # | finding_id | family_tag | 解消根拠（前回） | 再発根拠 | 問題 | 修正案 |
|---|------------|------------|----------------|---------|------|--------|
| 1 | CODE-REOPENED-src-file-L55 | bug | `前回: src/file.ts:10` | `src/file.ts:55` | {再発した問題} | {修正案} |

## 検証証跡
- 差分確認: {確認内容}
- ビルド: {結果。未確認ならその旨}
- テスト: {結果。未確認ならその旨}

## REJECT判定条件
- `new`、`persists`、または `reopened` が1件以上ある場合のみ REJECT
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリーのみ（5行以内）
- REJECT → 該当指摘のみ表で記載（30行以内）
