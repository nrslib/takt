```markdown
# テストレビュー

## 結果: APPROVE / REJECT

## サマリー
{1-2文で結果を要約}

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

## 問題系列の完了走査
| family_tag / 変更契約 | 不変条件・根本原因 | 定義・生成・検証 | 利用・永続化・再注入 | 失敗・中断・再試行・再開・並列・補助入口 | mock・fixture・test double | 未確認経路 | 判定 |
|-----------------------|-------------------|------------------|----------------------|------------------------------------------|----------------------------|------------|------|
| {問題系列または確認対象契約} | {守るべき条件} | {確認した場所} | {確認した場所} | {確認した経路} | {確認したテスト資産} | {なし、または未確認理由} | {問題なし / finding番号} |

## 今回の指摘（new）
| # | finding_id | family_tag | カテゴリ | 場所 | 問題 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|---|------------|------------|---------|------|------|---------------------|------------------------------|--------|
| 1 | TEST-NEW-src-test-L42 | test-structure | カバレッジ | `src/test.ts:42` | 問題の説明 | remediation_regression | 初回test review後の修正がこの挙動を変更した | 修正方法 |

follow-up finding の `Authorization basis` は `accepted_family_unvisited_consumer`、`remediation_regression`、`direct_acceptance_criterion_violation`、`required_consumer_migration` のいずれか正確な値に限定し、初回レビューでは「該当なし」とする。「初回に含まれなかった理由」は別の事実説明であり、初回レビューでは「該当なし」とする。

`persists` は、未解消であり、最新の `review-resolution.md` で `actionable` と裁定された finding、または未裁定の finding に限定する。`out_of_scope`、`overreach`、`false_positive`、`no_issue_after_verification`、または canonical finding へ統合済みの `duplicate` と裁定された finding を `persists` に置かない。

## 継続指摘（persists）
| # | finding_id | family_tag | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|------------|----------|----------|------|--------|
| 1 | TEST-PERSIST-src-test-L77 | test-structure | `src/test.ts:77` | `src/test.ts:77` | 未解消 | 修正方法 |

## 解消済み（resolved）
| finding_id | 解消根拠 |
|------------|----------|
| TEST-RESOLVED-src-test-L10 | `src/test.ts:10` でカバレッジ充足 |

## 裁定済みの対象外指摘
| finding_id | 最新の裁定 | 裁定根拠 |
|------------|------------|----------|
| {finding_id} | out_of_scope / overreach / false_positive / no_issue_after_verification / duplicate | `review-resolution.md` の裁定と根拠 |

## 再開指摘（reopened）
| # | finding_id | family_tag | 直前の裁定 | 再開根拠（a-d） | 新しい証拠 | 問題 | 修正案 |
|---|------------|------------|------------|----------------|------------|------|--------|
| 1 | TEST-REOPENED-src-test-L55 | test-structure | `review-resolution.md`: 解消済み | d | `src/test.ts:55 で再発` | 問題の説明 | 修正方法 |

`reopened` にできるのは、直前の裁定を明記した上で、次のいずれかを示す場合だけとする。(a) 裁定後に要求または受入条件が変わった、(b) 裁定が不足とした blocking 条件を満たす新しい具体的証拠を得た、(c) 裁定時の事実前提を現在のコードが反証している、(d) remediation が同じ問題を再導入した。同一事象の再測定、追加サンプル、重大度の言い換えは `reopened` の根拠にしない。

## 検証証跡
- ビルド: {確認対象・確認内容・結果。未確認ならその旨}
- テスト: {確認対象・確認内容・結果。未確認ならその旨}
- 動作確認: {確認対象・確認内容・結果。未確認ならその旨}

## 未確認範囲
| 項目 | 理由 | 判定への影響 |
|------|------|--------------|
| {未確認の範囲。なければ「なし」} | {未確認の理由} | {APPROVE可 / REJECT理由} |

## REJECT判定条件
- 有効な `Authorization basis` 付きの `new`、裁定に拘束された上記定義の `persists`、または有効な再開根拠（a-d）付きの `reopened` が1件以上ある場合のみ REJECT 可
- 裁定済みの対象外指摘は REJECT 判定に算入しない
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE かつ解消済み指摘なし → サマリー、未確認範囲、継続レビューで必要な確認観点・検証証跡のみ（簡潔に集約）
- APPROVE かつ解消済み指摘あり → サマリー、解消済み指摘、未確認範囲、継続レビューで必要な確認観点・検証証跡のみ（簡潔に集約）
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
- 最新の裁定に上記いずれかの裁定理由を持つ対象外の finding がある場合は、裁定済みの対象外指摘を必ず記載
