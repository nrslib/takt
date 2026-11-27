# 実装報告

- src/workdir.mjs を追加した。`fs.mkdtemp` で作業ディレクトリを作り、設定ファイルを写してから集計の処理を呼び、終了時に削除する。
- src/report.mjs の runReport が、写した設定を読んで集計するようにした。
- test/report.test.mjs に、集計中に元の設定ファイルを書き換えても、写した設定で集計されることのテストを追加した。`node --test` で 1 件成功。
