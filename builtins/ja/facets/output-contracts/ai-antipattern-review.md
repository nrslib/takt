```markdown
# AI生成コードレビュー

{{include:output-contracts/base-review-result}}

## サマリー
{1文で結果を要約}

## 検証した項目
| 観点 | 結果 | 備考 |
|------|------|------|
| 仮定の妥当性 | ✅ | - |
| API/ライブラリの実在 | ✅ | - |
| コンテキスト適合 | ✅ | - |
| スコープ | ✅ | - |

{{include:output-contracts/base-review-non-finding-concerns}}

{{include:output-contracts/base-review-problem-family-completion-sweep}}

{{include:output-contracts/base-review-new-findings-category}}
| 1 | AI-NEW-src-file-L23 | hallucination | 幻覚API | `src/file.ts:23` | 存在しないメソッド | direct_acceptance_criterion_violation | 初回レビュー証跡ではこの受入条件を確認していなかった | 実在APIへ置換 |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | AI-PERSIST-src-file-L42 | hallucination | `src/file.ts:42` | `src/file.ts:42` | 未解消 | 既存修正方針を適用 |

{{include:output-contracts/base-review-resolved-findings}}
| AI-RESOLVED-src-file-L10 | `src/file.ts:10` に該当問題なし |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | AI-REOPENED-src-file-L55 | hallucination | `review-resolution.md`: 解消済み | d | `src/file.ts:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-rescan-evidence}}

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- 問題なし → サマリー + チェック表 + 再走査証跡（2回目以降） + 必要な場合のみ非finding化した懸念
- 問題あり → 確認済みの指摘をすべて該当セクションへ記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
