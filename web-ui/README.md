# TAKT Web UI

TAKT に同梱されるローカル Web UI です。ブラウザーでタスクの作成と実行、ログやレポートの確認、失敗したタスクの再投入を行えます。

```sh
takt ui
takt ui --port 4180
takt ui stop
takt ui restart
takt ui restart --port 4180
```

既定では `http://127.0.0.1:20525` で起動します。起動時には、この Web UI が実験的機能であり、予告なく仕様が変更される可能性があることを表示します。`takt ui` の実行時に同じ `TAKT_CONFIG_DIR` の Web UI がすでに動いている場合は二重起動せず、既存インスタンスの URL と PID を表示します。`stop` はそのインスタンスをグレースフルに停止し、`restart` は停止完了後に同じ端末で起動し直します。

run を開始するには Viewer の「タスクを作成」を開き、実行ディレクトリと workflow を選んで Chat に依頼を入力します。`/setup` では Worktree、作業ブランチ、ベースブランチ、自動 PR、Draft PR を設定できます。`/go` で生成された実行指示を確認し、「この指示で実行」を押します。Viewer の Tasks と run workspace で進捗、ライブログ、レポートを確認できます。表示言語はヘッダーで日本語・英語を切り替えられます。自動 PR を有効にした場合は workflow 成功後に commit、push、PR 作成へ進みます。

タスクが失敗した場合は Run 詳細の `Requeue` から、同じ workflow と実行設定を引き継いで再投入できます。

## 保存先と実行上の制約

Web UI の実行記録は `TAKT_CONFIG_DIR/state/projects/<stateId>/` 以下に保存されます。同じプロジェクトを CLI と Web UI から同時に操作することはサポートしていません。異なる `TAKT_CONFIG_DIR` は別の管理領域です。

Web UI で MCP サーバーの認証情報を指定する場合は、値を `${ENV_VAR}` 形式の環境変数参照にしてください。認証情報を URL に直接書いた設定は使えません。
