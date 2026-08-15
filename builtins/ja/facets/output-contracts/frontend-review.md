```markdown
# フロントエンドレビュー

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## 確認した観点
| 観点 | 結果 | 備考 |
|------|------|------|
| コンポーネント設計 | ✅ | - |
| 状態管理 | ✅ | - |
| 正規状態と派生状態 | ✅ | - |
| パフォーマンス | ✅ | - |
| アクセシビリティ | ✅ | - |
| 型安全性 | ✅ | - |

{{include:output-contracts/base-review-problem-family-completion-sweep}}

## 今回の指摘（new）
| # | finding_id | family_tag | 場所 | 問題 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|---|------------|------------|------|------|---------------------|------------------------------|--------|
| 1 | FE-NEW-src-file-L42 | component-design | `src/file.tsx:42` | 問題の説明 | required_consumer_migration | 初回レビュー証跡ではこのconsumerを確認していなかった | 修正方法 |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | FE-PERSIST-src-file-L77 | component-design | `src/file.tsx:77` | `src/file.tsx:77` | 未解消 | 既存修正方針を適用 |

{{include:output-contracts/base-review-resolved-findings}}
| FE-RESOLVED-src-file-L10 | `src/file.tsx:10` は規約を満たす |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | FE-REOPENED-src-file-L55 | component-design | `review-resolution.md`: 解消済み | d | `src/file.tsx:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
- `finding_id` なしの指摘は無効
```

{{include:output-contracts/base-review-cognitive-load-with-resolved}}
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
