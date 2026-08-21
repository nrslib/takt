```markdown
# テストレビュー

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

テスト追加を要求する指摘には、守る観測可能な契約、壊れる具体的な経路、既存テストでは検出できない根拠を記録する。内部構造の固定や既存検証との重複だけを目的とする指摘は記録しない。

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

{{include:output-contracts/base-review-new-findings-category}}
| 1 | TEST-NEW-src-test-L42 | test-structure | カバレッジ | `src/test.ts:42` | 問題の説明 | `src/test.ts:42` | 修正方法 |

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | TEST-PERSIST-src-test-L77 | test-structure | `src/test.ts:77` | `src/test.ts:77` | 未解消 | 修正方法 |

{{include:output-contracts/base-review-resolved-findings}}
| TEST-RESOLVED-src-test-L10 | `src/test.ts:10` でカバレッジ充足 |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | TEST-REOPENED-src-test-L55 | test-structure | 直前の裁定: 解消済み | 修正で再発 | `src/test.ts:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

## 未確認範囲
| 項目 | 理由 | 判定への影響 |
|------|------|--------------|
| {未確認の範囲。なければ「なし」} | {未確認の理由} | {APPROVE可 / REJECT理由} |

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE かつ解消済み指摘なし → サマリー、未確認範囲、判断を裏付ける確認観点・検証証跡のみ（簡潔に集約）
- APPROVE かつ解消済み指摘あり → サマリー、解消済み指摘、未確認範囲、判断を裏付ける確認観点・検証証跡のみ（簡潔に集約）
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
