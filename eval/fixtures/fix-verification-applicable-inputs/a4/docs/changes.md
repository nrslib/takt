# 今回の変更

`--short` を追加した。指定された場合は Git の引数に `--short=7` を加える。
変更前は引数なしで起動し、`git rev-parse HEAD` の結果を表示していた。
`src/cli.mjs` の `spawnSync` による Git の起動方法とエラー処理は変更前から同じである。
