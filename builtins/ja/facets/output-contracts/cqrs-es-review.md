```markdown
# CQRS+ESレビュー

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## 確認した観点
| 観点 | 結果 | 備考 |
|------|------|------|
| Aggregate設計 | ✅ | - |
| イベント設計 | ✅ | - |
| Command/Query分離 | ✅ | - |
| プロジェクション | ✅ | - |
| 結果整合性 | ✅ | - |

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | CQRS-NEW-src-file-L42 | cqrs-violation | スコープ内 | `src/file.ts:42` | 問題の説明 | `src/file.ts:42` | 修正方法 |

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | CQRS-PERSIST-src-file-L77 | cqrs-violation | `src/file.ts:77` | `src/file.ts:77` | 未解消 | 既存修正方針を適用 |

{{include:output-contracts/base-review-resolved-findings}}
| CQRS-RESOLVED-src-file-L10 | `src/file.ts:10` は規約を満たす |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | CQRS-REOPENED-src-file-L55 | cqrs-violation | 直前の裁定: 解消済み | 修正で再発 | `src/file.ts:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
{{include:output-contracts/base-review-rejection-gate-in-scope}}
- `finding_id` なしの指摘は無効
```

{{include:output-contracts/base-review-cognitive-load-with-resolved}}
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
