```markdown
# セキュリティレビュー

## 結果: APPROVE / REJECT

## 重大度: None / Low / Medium / High / Critical

## チェック結果
| カテゴリ | 結果 | 備考 |
|---------|------|------|
| インジェクション | ✅ | - |
| 認証・認可 | ✅ | - |
| データ保護 | ✅ | - |
| 依存関係 | ✅ | - |

## 問題系列の完了走査
| family_tag / 変更契約 | 不変条件・根本原因 | 定義・生成・検証 | 利用・永続化・再注入 | 失敗・中断・再試行・再開・並列・補助入口 | mock・fixture・test double | 未確認経路 | 判定 |
|-----------------------|-------------------|------------------|----------------------|------------------------------------------|----------------------------|------------|------|
| {問題系列または確認対象契約} | {守るべき条件} | {確認した場所} | {確認した場所} | {確認した経路} | {確認したテスト資産} | {なし、または未確認理由} | {問題なし / finding番号} |

## 今回の指摘（new）
| # | finding_id | family_tag | 重大度 | 種類 | 場所 | 問題 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|---|------------|------------|--------|------|------|------|---------------------|------------------------------|--------|
| 1 | SEC-NEW-src-db-L42 | injection-risk | High | SQLi | `src/db.ts:42` | 生SQL文字列 | direct_acceptance_criterion_violation | 初回レビュー証跡は別のquery入口だけを確認していた | パラメータ化クエリを使用 |

follow-up finding の `Authorization basis` は `accepted_family_unvisited_consumer`、`remediation_regression`、`direct_acceptance_criterion_violation`、`required_consumer_migration` のいずれか正確な値に限定し、初回レビューでは「該当なし」とする。「初回に含まれなかった理由」は別の事実説明であり、初回レビューでは「該当なし」とする。

`persists` は、未解消であり、最新の `review-resolution.md` で `actionable` と裁定された finding、または未裁定の finding に限定する。`out_of_scope`、`overreach`、`false_positive`、`no_issue_after_verification`、または canonical finding へ統合済みの `duplicate` と裁定された finding を `persists` に置かない。

## 継続指摘（persists）
| # | finding_id | family_tag | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|------------|----------|----------|------|--------|
| 1 | SEC-PERSIST-src-auth-L18 | injection-risk | `src/auth.ts:18` | `src/auth.ts:18` | 未解消 | バリデーションを強化 |

## 解消済み（resolved）
| finding_id | 解消根拠 |
|------------|----------|
| SEC-RESOLVED-src-db-L10 | `src/db.ts:10` はバインド変数化済み |

## 裁定済みの対象外指摘
| finding_id | 最新の裁定 | 裁定根拠 |
|------------|------------|----------|
| {finding_id} | out_of_scope / overreach / false_positive / no_issue_after_verification / duplicate | `review-resolution.md` の裁定と根拠 |

## 再開指摘（reopened）
| # | finding_id | family_tag | 直前の裁定 | 再開根拠（a-d） | 新しい証拠 | 問題 | 修正案 |
|---|------------|------------|------------|----------------|------------|------|--------|
| 1 | SEC-REOPENED-src-auth-L55 | injection-risk | `review-resolution.md`: 解消済み | d | `src/auth.ts:55 で再発` | 問題の説明 | 修正方法 |

`reopened` にできるのは、直前の裁定を明記した上で、次のいずれかを示す場合だけとする。(a) 裁定後に要求または受入条件が変わった、(b) 裁定が不足とした blocking 条件を満たす新しい具体的証拠を得た、(c) 裁定時の事実前提を現在のコードが反証している、(d) remediation が同じ問題を再導入した。同一事象の再測定、追加サンプル、重大度の言い換えは `reopened` の根拠にしない。

## 検証証跡
- ビルド: {確認対象・確認内容・結果。未確認ならその旨}
- テスト: {確認対象・確認内容・結果。未確認ならその旨}
- 動作確認: {確認対象・確認内容・結果。未確認ならその旨}

## 警告（非ブロッキング）
- {セキュリティに関する推奨事項}

## REJECT判定条件
- 有効な `Authorization basis` 付きの `new`、裁定に拘束された上記定義の `persists`、または有効な再開根拠（a-d）付きの `reopened` が1件以上ある場合のみ REJECT 可
- 裁定済みの対象外指摘は REJECT 判定に算入しない
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- 問題なし → チェック表のみ（10行以内）
- 警告のみ → + 警告1-2行（15行以内）
- 脆弱性あり → 確認済みの指摘をすべて表へ記載し、同じ原因の場所は集約
- 最新の裁定に上記いずれかの裁定理由を持つ対象外の finding がある場合は、裁定済みの対象外指摘を必ず記載
