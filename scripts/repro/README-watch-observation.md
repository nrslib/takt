# process watch 観測プローブ

macOSで同じPIDを持つ3件の匿名タスクを`startDaemonWatchers`経由で監視する。既定では専用の子プロセスを作り、終了時に片付ける。各回の`AsyncProcess.inspect`と直接の`/bin/ps -p PID -o lstart=`の所要時間をJSON行で記録する。

## 実行

リポジトリのルートでビルドしてから実行する。出力は自分で指定したファイルへ保存する。

```sh
npm run build
node scripts/repro/watch-observation.mjs > /tmp/watch-observation.jsonl
```

既存プロセスを観測する場合は`--pid`に対象PIDを渡す。次の例では`12345`を対象PIDに置き換える。

```sh
node scripts/repro/watch-observation.mjs --pid 12345 > /tmp/watch-observation.jsonl
```

観測時間は90秒。正常終了時は進行中の巡回を待つため少し延びる場合があり、安全上限は130秒。既存PIDモードは監視対象を終了せず、`/bin/ps`と製品コードの`kill(pid, 0)`による生存照会だけを行う。開始前にPIDの識別情報を取得できなければ`not_started`を記録して失敗終了する。開始後の直接照会が失敗した場合は`native_ps`に`timeout`または`error`を記録し、監視を続ける。

## 観測できる範囲

`startDaemonWatchers`、`WatchChecks`、`AsyncProcess`、`AsyncCommand`、`ioScope`、macOSの`/bin/ps`は実物を使う。タスク列挙、観測記録、イベント受付は匿名のインメモリfixtureである。遅延は注入しない。3対象は逐次観測されるため、それぞれの照会が5秒程度で失敗する場合は3巡目まで約1分を要する。

2026-11-23にmacOSとNode 26.5.1で測った対照結果は次のとおり。両実行とも終了コード0で、`watch_failed`と監視エラーは0件だった。

| 対象 | `inspect` | 直接の`/bin/ps` |
| --- | --- | --- |
| 専用の子プロセス | 54回すべて`alive`、4〜28ms | 45回すべて成功、4〜31ms |
| 既存worker | 54回すべて`alive`、5〜20ms | 45回すべて成功、5〜24ms |

調査時の詳細ログはローカルの`.takt/tmp/watch-observation-repro-validation/`に保存した。バージョン管理には含めない。専用の子プロセスの終了も確認した。

過去の本番記録には3対象の`watch_failed`と近い時刻の`I/O deadline exceeded`がある。ただしログには失敗したI/O操作と対象の対応がなく、5秒に達した原因は確定していない。このプローブでもその故障は再現していない。`watch_failed`を観測できても、それだけで過去の故障と同じ原因とは判断できない。
