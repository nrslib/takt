計画に従って Terraform コードを実装してください。
Piece Contextに示されたReport Directory内のファイルのみ参照してください。他のレポートディレクトリは検索/参照しないでください。

**重要**: 実装完了後、以下の検証を順番に実行してください。
1. `terraform fmt -check` — フォーマット違反があれば `terraform fmt` で修正
2. `terraform validate` — 構文・型エラーの確認
3. `terraform plan` — 変更内容の確認（意図しない変更がないこと）

**注意事項:**
- `terraform apply` は絶対に実行しない
- 機密情報（パスワード、トークン）をコードに書かない
- 既存リソースの `lifecycle { prevent_destroy = true }` を無断で削除しない
- 新しい variable を追加する場合は `type` と `description` を必ず付ける

**Scope出力契約（実装開始時に作成）:**
```markdown
# 変更スコープ宣言

## タスク
{タスクの1行要約}

## 変更予定
| 種別 | ファイル |
|------|---------|
| 作成 | `modules/example/main.tf` |
| 変更 | `environments/sandbox/main.tf` |

## 推定規模
Small / Medium / Large

## 影響範囲
- {影響するモジュールやリソース}
```

**Decisions出力契約（実装完了時、決定がある場合のみ）:**
```markdown
# 決定ログ

## 1. {決定内容}
- **背景**: {なぜ決定が必要だったか}
- **検討した選択肢**: {選択肢リスト}
- **理由**: {選んだ理由}
- **コスト影響**: {ある場合のみ}
```

**必須出力（見出しを含める）**
## 作業結果
- {実施内容の要約}
## 変更内容
- {変更内容の要約}
## 検証結果
- {terraform fmt -check の結果}
- {terraform validate の結果}
- {terraform plan の結果サマリー（追加/変更/削除のリソース数）}
