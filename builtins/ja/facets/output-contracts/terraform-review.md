```markdown
# Terraform 規約レビュー

{{include:output-contracts/base-review-result}}

{{include:output-contracts/base-review-summary}}

## 確認した観点
- [x] 変数宣言（type, description, sensitive）
- [x] リソース命名（name_prefix パターン）
- [x] ファイル構成（1ファイル1関心事）
- [x] セキュリティ設定
- [x] タグ管理
- [x] lifecycle ルール
- [x] コストトレードオフ文書化

{{include:output-contracts/base-review-new-findings-scope}}
| 1 | TF-NEW-file-L42 | tf-convention | スコープ内 | `modules/example/main.tf:42` | 問題の説明 | `modules/example/main.tf:42` | 修正方法 |

{{include:output-contracts/base-review-scope}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | TF-PERSIST-file-L77 | tf-convention | `file.tf:77` | `file.tf:77` | 未解消 | 既存修正方針を適用 |

{{include:output-contracts/base-review-resolved-findings}}
| TF-RESOLVED-file-L10 | `file.tf:10` は規約を満たす |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | TF-REOPENED-file-L55 | tf-convention | 直前の裁定: 解消済み | 修正で再発 | `file.tf:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリーのみ（5行以内）
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
