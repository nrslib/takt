# coding-review

## 結果: REJECT

- CODE-1（new）: 今回追加した検索処理では、利用者が PATH に相対要素だけを設定していると、外部コマンドが見つからず、エラーの文言が分かりにくい。
  - 条件: 作業ディレクトリの `tools/audio-encode` が実行可能で、PATH が `tools` のみ。
  - コードの確認: `src/encoder.mjs` は PATH の各要素を `isAbsolute` で検査し、相対要素をすべて飛ばす。この条件では候補を調べず `Encoder unavailable` を投げる。`src/cli.mjs` の `runCli` はこの例外を呼び出し元へ返す。
  - 修正案: 相対要素からもコマンドを検索して起動し、検索失敗時には原因が分かるエラーにする。
