# TAKT Web UI

TAKT本体に同梱されるローカルWeb UIです。実装はこのディレクトリに隔離し、workflow engineやTUIの内部実装には依存しません。

Web UI の task と run は、`TAKT_CONFIG_DIR/state/projects/<stateId>/` 以下の channel-neutral central state に保存されます。起動時は exact-task の内部 one-shot worker を detached child として起動し、中央 task ledger の CAS と active execution record が二重起動を防ぎます。UI は `takt run` を別途起動せず、worker が通常の workflow execution を呼び出します。

中央 state には `tasks/`、`runs/`、`sessions/`、`events/`、`locks/` が含まれ、プロジェクトの `.takt` には Web UI の framework state を書き込みません。provider、quality gate、MCP、Companion の子プロセスへ central config/ownership namespace は継承しません。

CLI の project-local state と Web UI の central state は characterization のため別 locator です。同一 canonical project に対する CLI と Web UI の同時実行・mutationは今回サポートしません。異なる `TAKT_CONFIG_DIR` は別 namespace です。

```sh
takt ui
takt ui --port 4180
```

既定では `http://127.0.0.1:4178` で起動します。
