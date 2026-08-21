```markdown
# アーキテクチャレビュー

## 結果: APPROVE / IMPROVE / REJECT

{{include:output-contracts/base-review-summary}}

## 確認した観点
- [x] 構造・設計
- [x] コード品質
- [x] 変更スコープ
- [x] テストカバレッジ
- [x] デッドコード
- [x] 呼び出しチェーン検証

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | ARCH-NEW-src-file-L42 | design-violation | スコープ内 | `src/file.ts:42` | 問題の説明 | `src/file.ts:42` | 修正方法 |

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | ARCH-PERSIST-src-file-L77 | design-violation | `src/file.ts:77` | `src/file.ts:77` | 未解消 | 既存修正方針を適用 |

{{include:output-contracts/base-review-resolved-findings}}
| ARCH-RESOLVED-src-file-L10 | `src/file.ts:10` は規約を満たす |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | ARCH-REOPENED-src-file-L55 | design-violation | 直前の裁定: 解消済み | 修正で再発 | `src/file.ts:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

{{include:output-contracts/base-review-rescan-evidence}}

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
{{include:output-contracts/base-review-rejection-gate-in-scope}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリー + 検証証跡 + 影響経路の確認証跡。それ以外は省略
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
