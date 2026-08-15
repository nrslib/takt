```markdown
# セキュリティレビュー

{{include:output-contracts/base-review-result}}

## 重大度: None / Low / Medium / High / Critical

## サマリー
{確認したセキュリティ結果を1～2文で要約}

{{include:output-contracts/base-review-problem-family-completion-sweep}}

## 今回の指摘（new）
| # | finding_id | family_tag | 重大度 | 種類 | 場所 | 問題 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|---|------------|------------|--------|------|------|------|---------------------|------------------------------|--------|
| 1 | SEC-NEW-src-db-L42 | injection-risk | High | SQLi | `src/db.ts:42` | 生SQL文字列 | direct_acceptance_criterion_violation | 初回レビュー証跡は別のquery入口だけを確認していた | パラメータ化クエリを使用 |

{{include:output-contracts/base-review-follow-up-authorization}}

{{include:output-contracts/base-review-persists}}
{{include:output-contracts/base-review-carry-over-findings}}
| 1 | SEC-PERSIST-src-auth-L18 | injection-risk | `src/auth.ts:18` | `src/auth.ts:18` | 未解消 | バリデーションを強化 |

{{include:output-contracts/base-review-resolved-findings}}
| SEC-RESOLVED-src-db-L10 | `src/db.ts:10` はバインド変数化済み |

{{include:output-contracts/base-review-adjudicated-out-of-scope}}
{{include:output-contracts/base-review-reopened-findings}}
| 1 | SEC-REOPENED-src-auth-L55 | injection-risk | `review-resolution.md`: 解消済み | d | `src/auth.ts:55 で再発` | 問題の説明 | 修正方法 |

{{include:output-contracts/base-review-reopened}}
{{include:output-contracts/base-review-verification-evidence}}

## 警告（非ブロッキング）
- {セキュリティに関する推奨事項}

## REJECT判定条件
{{include:output-contracts/base-review-rejection-gate}}
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- 初回の APPROVE で finding も引き継ぐ裁定もない → 結果: APPROVE、重大度: None、1～2文のサマリーだけ
- APPROVE で警告のみ → 警告を1～2行追加
- follow-up の APPROVE → follow-up 契約で必要な裁定済み・解消済み・検証の既存 section だけを追加
- 脆弱性あり → 確認済みの指摘をすべて表へ記載し、同じ原因の場所は集約
{{include:output-contracts/base-review-adjudicated-out-of-scope-reporting}}
