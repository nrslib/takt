```markdown
# テストレビュー

## 結果: APPROVE / REJECT

## サマリー
{1-2文で結果を要約}

## 確認した観点
| 観点 | 結果 | 備考 |
|------|------|------|
| テストカバレッジ | ✅ | - |
| テスト構造（Given-When-Then） | ✅ | - |
| テスト命名 | ✅ | - |
| テスト独立性・再現性 | ✅ | - |
| モック・フィクスチャ | ✅ | - |
| テスト戦略（ユニット/統合/E2E） | ✅ | - |
| 契約入力位置（body/query/path） | ✅ | - |

## 今回の指摘（new）
| # | finding_id | family_tag | カテゴリ | 場所 | 問題 | 修正案 |
|---|------------|------------|---------|------|------|--------|
| 1 | TEST-NEW-src-test-L42 | test-structure | カバレッジ | `src/test.ts:42` | 問題の説明 | 修正方法 |

## 継続指摘（persists）
| # | finding_id | family_tag | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|------------|----------|----------|------|--------|
| 1 | TEST-PERSIST-src-test-L77 | test-structure | `src/test.ts:77` | `src/test.ts:77` | 未解消 | 修正方法 |

## 解消済み（resolved）
| finding_id | 解消根拠 |
|------------|----------|
| TEST-RESOLVED-src-test-L10 | `src/test.ts:10` でカバレッジ充足 |

## 再開指摘（reopened）
| # | finding_id | family_tag | 解消根拠（前回） | 再発根拠 | 問題 | 修正案 |
|---|------------|------------|----------------|---------|------|--------|
| 1 | TEST-REOPENED-src-test-L55 | test-structure | `前回: src/test.ts:10 で修正済み` | `src/test.ts:55 で再発` | 問題の説明 | 修正方法 |

## REJECT判定条件
- `new`、`persists`、または `reopened` が1件以上ある場合のみ REJECT 可
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリーのみ（5行以内）
- REJECT → 該当指摘のみ表で記載（30行以内）
