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

## 今回の指摘（new）
| # | finding_id | スコープ | 場所 | 問題 | 修正案 |
|---|------------|---------|------|------|--------|
| 1 | TF-NEW-file-L42 | スコープ内 | `modules/example/main.tf:42` | 問題の説明 | 修正方法 |

スコープ: 「スコープ内」（今回修正可能）/ 「スコープ外」（既存問題・非ブロッキング）

## 継続指摘（persists）
| # | finding_id | 前回根拠 | 今回根拠 | 問題 | 修正案 |
|---|------------|----------|----------|------|--------|
| 1 | TF-PERSIST-file-L77 | `file.tf:77` | `file.tf:77` | 未解消 | 既存修正方針を適用 |

## 解消済み（resolved）
| finding_id | 解消根拠 |
|------------|----------|
| TF-RESOLVED-file-L10 | `file.tf:10` は規約を満たす |

## REJECT判定条件
- `new` または `persists` が1件以上ある場合のみ REJECT 可
- `finding_id` なしの指摘は無効
```

**認知負荷軽減ルール:**
- APPROVE → サマリーのみ（5行以内）
- REJECT → 該当指摘のみ表で記載（30行以内）
