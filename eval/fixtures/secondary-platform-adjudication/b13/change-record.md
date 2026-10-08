# 今回の変更
変更前の `src/runner.previous.mjs` は Windows でもタスクを開始できた。隔離なし実行を禁止する今回の変更で `src/runner.mjs` に OS 別 launcher を追加したが、darwin/linux しか定義していない。Windows では試行記録を書いた後で失敗し、変更前の実行経路が壊れた。隔離なしの旧経路へ戻すことは今回の安全条件と両立しない。
