# バッチの対象設定

対象一覧への名前追加前から、利用者本人が `batch.json` に対象を指定しています。
`node src/cli.mjs init` で作った雛形を編集します。保存形式は `schema/config.json` にあります。
名前は同じ設定の中で重複させません。雛形と文書の例は次のとおりです。

```json
{ "targets": ["daily-export", "weekly-cleanup"] }
```

`node src/cli.mjs list` で実行前の対象を確認します。
`node src/cli.mjs run` は設定の対象を読み込み、実行記録を `history.json` に保存します。
`node src/cli.mjs history` は実行記録の対象名を表示します。
設定の取り込みや、他の利用者が設定を書き込む機能はありません。

変更前から実行履歴の一覧は `displayName` を使っています。

実行前の一覧は各対象の名前を1行ずつ表示します。実行履歴と同じ `displayName` を使います。
設定の保存値、対象の順序、実行に渡す名前、実行履歴の表示は変更しません。
