# worker pool とクラウドでの導入

[English](./worker-pool.md) | [日本語](./worker-pool.ja.md) | [简体中文](./worker-pool.zh-CN.md)

worker pool は daemon が自動実行する manager のゴールタスクを、daemon マシンの組み込み worker と別マシンのリモート worker に分けて実行する仕組みです。manager の会話と割り当ては daemon 側に置き、worker は空きがあると daemon へ仕事を要求します。複数のリポジトリで同じ pool を共有し、worker の上限と各プロジェクトの `concurrency` の両方で同時実行数を制限します。

1台で使う場合の手順は変わりません。worker を登録しなければ組み込み worker が実行します。`takt run`、`takt watch`、対話モードは従来のローカル実行を使います。これらをリモート worker に送る設定ではありません。

## コードと実行資産の受け渡し

daemon はタスクの元になる SHA を確定して origin に push します。worker は origin からその SHA のコードを取得し、指示書、添付、workflow、facet、解決済み設定を daemon から受け取ります。worker 側へリポジトリ別の TAKT 設定や workflow を手作業で配置する必要はありません。

worker は成果を origin へ push し、run のログとレポートを daemon へ送ります。daemon は記録の受領と成果の fetch・SHA 照合を済ませてから完了を保存します。接続できたことだけではタスクの成功になりません。

## daemon マシンの準備

クラウドインスタンスに Node.js 22.22.0 以降、利用する版の TAKT、Git、manager と組み込み worker に必要な provider・プロジェクトの道具を用意します。Git のコミット名・メールアドレスも実行ユーザーに設定します。SDK は事前に `takt install codex` などで導入してください。必要な対象は [CLI リファレンス](./cli-reference.ja.md#管理sdkの導入と更新)で確認できます。

daemon の実行ユーザーでリポジトリを配置し、origin を設定します。daemon には元ブランチの push と成果の fetch、worker にはコード取得と成果ブランチの push の権限が必要です。このガイドでは Git トークンで認証できる HTTPS の origin を使います。トークンを origin URL に埋め込まないでください。PR 操作を使う場合は `gh` とその操作権限も用意します。

同じユーザーで各リポジトリの `takt manager` を一度開き、担当プロジェクトとして登録します。ゴールタスクの自動実行には `manager.auto_run: true` と実行可能な pending のゴールタスクが必要です。ゴールの作成と操作は[ゴール管理ガイド](./goal-management.ja.md)を参照してください。クラウドの manager とはそのインスタンス上の端末か設定済みの Slack で会話します。TUI や Web UI を worker の通信口へ接続することはできません。

daemon のグローバル設定 `~/.takt/config.yaml` に次を追加します。`TAKT_CONFIG_DIR` を使っている場合は、そのディレクトリの `config.yaml` です。

```yaml
daemon:
  builtin_worker:
    concurrency: 1
  remote_worker:
    host: 127.0.0.1
    port: 54322
    credentials:
      git: ${WORKER_GIT_TOKEN}
      gh: ${WORKER_GH_TOKEN}
      providers:
        openai: ${WORKER_OPENAI_KEY}
```

参照先の秘密値は daemon を起動するサービスの環境へ、クラウドの秘密情報管理などから注入します。名前は例であり、TAKT が自動的に読む環境変数名ではありません。不要な認証の項目は削除してください。設定した参照先が空か未設定だと認証配送が失敗します。daemon 自身の Git・gh・manager 用認証も、その実行環境で別途利用できるようにします。`credentials` はリモートタスクへの配布設定です。

組み込み上限を1にしておくと PRマージ用タスクも実行できます。0にすると通常タスクもマージ用タスクも組み込みでは実行されず、マージ用タスクは進みません。未指定時との違い、配布できる provider の一覧と優先関係は[daemon 設定](./configuration.ja.md#daemon-worker-pool)を参照してください。

## HTTPS と常駐起動

上の例は同じインスタンスのリバースプロキシから HTTP 接続を受ける待受です。外部には `https://daemon.example.test` のような URL を用意し、TLS をリバースプロキシなどで終端します。TAKT 自身は TLS を終端しません。VPN を使う場合も worker の接続 URL は HTTPS が必要で、平文 HTTP の例外は localhost だけです。

前段は `POST /worker` の要求・応答を両方向に流し続けられる必要があります。HTTP/1.1 の継続する NDJSON 通信を中継し、要求・応答を全件バッファしてから送る設定を避け、長時間の接続を切らないようタイムアウトを設定します。Authorization ヘッダーを転送し、アクセスログへその値を記録しないでください。54322番の内部待受は必要な前段からだけ到達できるようにします。worker は外向きに接続するため、worker 側の受信用ポートは不要です。

サービス管理ツールで daemon の実行ユーザー、安定した HOME・設定ディレクトリ、認証情報、PATH を指定し、次のコマンドを前面で実行するサービスをOS起動時に開始するよう設定します。異常終了後の再起動もサービス管理ツールに任せます。

```sh
takt daemon --resident
```

すでに daemon が動いている場合は `takt daemon stop` で停止してから起動します。設定変更後も同じ手順で再起動してください。`--resident` は自動終了を抑える指定であり、OSの再起動後に自動起動する指定ではありません。停止・版違い・通常起動の終了条件は [CLI リファレンス](./cli-reference.ja.md#manager実験的)を参照してください。

## worker の登録と無人起動

daemon と同じユーザー・設定ディレクトリで登録します。

```sh
takt worker add cloud-1 --concurrency 2
takt worker list
```

登録時の標準出力が接続用トークンです。一度だけ表示され、`list` からは再取得できません。worker を増やすときは別の名前で登録し、それぞれのトークンを渡します。同じ登録で別の接続を作ると先の接続は閉じられます。`list` は登録名と concurrency を表示します。接続中かどうかを示す一覧ではありません。コマンドの詳細は [worker CLI](./cli-reference.ja.md#worker)を参照してください。

worker 用のイメージには daemon と同じバージョンの TAKT、Node.js、Git、コミット名・メールアドレス、利用する provider の SDK・CLI、プロジェクトが使うビルド・テスト用の道具を含めます。PR 操作や workflow が使う場合は `gh` も必要です。SDK の導入には `takt install <provider>` を使い、OpenCode の外部 CLI など別途必要な道具も事前に用意します。daemon の設定が指定する実行パスを worker 側でも利用できるようにしてください。道具のバイナリまで転送されるわけではありません。

クラウドの起動スクリプトやサービスへ、次のスクリプトを設定します。起動時に渡す worker 固有の接続設定は URL と登録トークンだけです。両変数はこのスクリプト用で、TAKT 自体の環境変数設定ではありません。

```sh
#!/bin/sh
set -eu
: "${WORKER_DAEMON_URL:?Set the daemon HTTPS URL}"
: "${WORKER_REGISTRATION_TOKEN:?Inject the worker registration token}"
exec takt worker --url "$WORKER_DAEMON_URL" --token "$WORKER_REGISTRATION_TOKEN"
```

たとえば URL は `https://daemon.example.test` とし、トークンは登録時の値を秘密情報管理から注入します。文書やテンプレートで値を示す必要がある場合は `EXAMPLE_NOT_A_VALID_TOKEN` のような偽物を使ってください。実値をイメージ、Git、起動ログへ保存せず、シェルのコマンド追跡も有効にしません。トークンはプロセス引数で渡すため、worker の実行環境を信頼する利用者に限定します。この準備をイメージと起動設定で済ませれば、起動後に worker サーバーへログインする必要はありません。

## 動作確認と運用上の制約

worker の起動出力で `Worker cloud-1 connected` を確認します。次に daemon 側の manager でゴールタスクを投入し、タスク一覧の worker 名、実行結果、daemon に集まった run のログ・レポートを確認します。`builtin` が実行する場合もあります。リモートだけの実行を確認するため組み込み上限を0にする場合は、確認後に戻して daemon を再起動してください。その間は PRマージ用タスクと origin のないタスクが進みません。

通信断は60秒の lease 期限内なら同じ実行を継続できます。期限切れのタスクは失敗として記録され、受領済みの記録は残ります。失敗タスクは元 worker の空きを一つ予約します。requeue/retry で同じ worker の作業場所が残っていれば再開できます。登録削除や再試行時の60秒の切断では別 worker の空きを使い、保存した元SHAから最初から実行します。作業場所が消失した場合も、新しい作業場所で元SHAから実行します。途中状態を別 worker へ移す機能ではありません。

登録を止めるには daemon 側で次を実行します。実行中なら切断され、その割り当ての成果は以後受理されません。

```sh
takt worker remove cloud-1
```

登録削除は接続トークンを無効にしますが、配布済みの Git トークンは失効させません。必要な場合は GitHub 側でも無効化してください。gh や provider の認証情報も発行元で管理します。配布対象の認証はタスク子プロセスへ渡るため、登録する worker を信頼できるマシンに限定します。登録と認証の配布にはリポジトリごとの権限分離がありません。

PRマージ用タスクと origin のないタスクは組み込み worker だけが実行します。ラベルや provider による割り当て、クラウド API・SSH によるマシンの作成・起動・削除、manager の会話からの worker 登録・削除・トークン発行は提供していません。実行環境の用意と起動は利用者のクラウド設定で行います。
