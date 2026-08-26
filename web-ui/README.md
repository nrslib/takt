# TAKT Web UI

TAKT本体に同梱されるローカルWeb UIです。実装はこのディレクトリに隔離し、workflow engineやTUIの内部実装には依存しません。

Web UI の task と run は、`TAKT_CONFIG_DIR/state/projects/<stateId>/` 以下の channel-neutral central state に保存されます。起動時は exact-task の内部 one-shot worker を detached child として起動し、中央 task ledger の CAS と active execution record が二重起動を防ぎます。UI は `takt run` を別途起動せず、worker が通常の workflow execution を呼び出します。

中央 state には `tasks/`、`runs/`、`sessions/`、`events/`、`locks/` が含まれ、プロジェクトの `.takt` には Web UI の framework state を書き込みません。provider、quality gate、MCP、Companion の子プロセスへ central config/ownership namespace は継承しません。

中央 workflow bundle では、`LOG_LEVEL`、`NODE_ENV`、`ENDPOINT`、`Content-Type` など通常の MCP env/header 値を保持できます。credential-bearing key/flag の値は完全な `${ENV_VAR}` 参照だけを許可し、リテラルや混在値を拒否します。MCP URL は userinfo と credential-bearing query/fragment を拒否し、`version=2` のような通常 query は許可します。CLI のローカル bundle にはこの中央境界を適用しません。

CLI の project-local state と Web UI の central state は characterization のため別 locator です。同一 canonical project に対する CLI と Web UI の同時実行・mutationは今回サポートしません。異なる `TAKT_CONFIG_DIR` は別 namespace です。

```sh
takt ui
takt ui --port 4180
takt ui stop
takt ui restart
takt ui restart --port 4180
```

既定では `http://127.0.0.1:4178` で起動します。`takt ui` の実行時に同じ `TAKT_CONFIG_DIR` の Web UI がすでに動いている場合は二重起動せず、既存インスタンスの URL と PID を表示します。`stop` はそのインスタンスをグレースフルに停止し、`restart` は停止完了後に同じ端末で起動し直します。

run を開始するには、実行ディレクトリと workflow を選んで Chat へ相談内容を入力します。`/go` を送ると会話が実行指示へ変換されるので、表示された「この指示で実行」を押します。Web UI は中央 task へ投入して one-shot worker を起動し、実行中の状態とログを Run ペインへ表示します。
