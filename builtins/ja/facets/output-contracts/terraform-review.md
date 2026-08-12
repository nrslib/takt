```markdown
# Terraform 規約レビュー

## 結果: APPROVE / REJECT

## サマリー
{1-2文で結果を要約}

## 確認した観点
- [x] 変数宣言（type, description, sensitive）
- [x] リソース命名（name_prefix パターン）
- [x] ファイル構成（1ファイル1関心事）
- [x] セキュリティ設定
- [x] タグ管理
- [x] lifecycle ルール
- [x] コストトレードオフ文書化

## 問題系列の完了走査
| family_tag / 変更契約 | 不変条件・根本原因 | 定義・生成・検証 | 利用・永続化・再注入 | 失敗・中断・再試行・再開・並列・補助入口 | mock・fixture・test double | 未確認経路 | 判定 |
|-----------------------|-------------------|------------------|----------------------|------------------------------------------|----------------------------|------------|------|
| {問題系列または確認対象契約} | {守るべき条件} | {確認した場所} | {確認した場所} | {確認した経路} | {確認したテスト資産} | {なし、または未確認理由} | {問題なし / finding番号} |

## 今回の指摘（new）
| # | finding_id | family_tag | スコープ | 場所 | 問題 | Authorization basis | 初回に含まれなかった理由 | 修正案 |
|---|------------|------------|---------|------|------|---------------------|------------------------------|--------|
| 1 | TF-NEW-file-L42 | tf-convention | スコープ内 | `modules/example/main.tf:42` | 問題の説明 | accepted_family_unvisited_consumer | 初回レビュー証跡ではこのmodule consumerを確認していなかった | 修正方法 |

follow-up finding の `Authorization basis` は `accepted_family_unvisited_consumer`、`remediation_regression`、`direct_acceptance_criterion_violation`、`required_consumer_migration` のいずれか正確な値に限定し、初回レビューでは「該当なし」とする。「初回に含まれなかった理由」は別の事実説明であり、初回レビューでは「該当なし」とする。

スコープ: 「スコープ内」（今回修正可能）/ 「スコープ外」（既存問題・非ブロッキング）

## 継続指摘（persists）
| # | finding_id | family_tag | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|------------|----------|----------|------|--------|
| 1 | TF-PERSIST-file-L77 | tf-convention | `file.tf:77` | `file.tf:77` | 未解消 | 既存修正方針を適用 |

## 解消済み（resolved）
| finding_id | 解消根拠 |
|------------|----------|
| TF-RESOLVED-file-L10 | `file.tf:10` は規約を満たす |

## 再開指摘（reopened）
| # | finding_id | family_tag | 解消根拠（前回） | 再発根拠 | 問題 | 修正案 |
|---|------------|------------|----------------|---------|------|--------|
| 1 | TF-REOPENED-file-L55 | tf-convention | `前回: file.tf:10 で修正済み` | `file.tf:55 で再発` | 問題の説明 | 修正方法 |

## REJECT判定条件
- `new`、`persists`、または `reopened` が1件以上ある場合のみ REJECT 可
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリーのみ（5行以内）
- REJECT → 確認済みの指摘をすべて表で記載し、同じ原因の場所は集約
