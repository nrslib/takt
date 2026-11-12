# worker pool の実行契約

## 範囲

daemon が自動実行する manager のゴールタスクと PR マージ用タスクを一つの dispatcher に通す。今回実装するのは組み込み worker と割り当て規則だけである。ネットワーク接続、登録、認証情報の配布、リモートでの失敗予約は後続タスクで実装する。この文書で「リモート」と付けた契約は後続実装の前提であり、現在の公開 API を意味しない。

手動の `takt run`、`takt watch`、対話モードは移行しない。`--resident` とバージョン差による daemon の扱いは別タスク `add-resident-daemon-option` が担当する。

## dispatcher と組み込み worker

daemon の `TaskDispatcher` が登録済みの全プロジェクトを読み、pending の候補と実行中の割り当てから次の割り当てを決める。起動時、ファイル変更通知、終了通知、定期確認で同じ処理を呼ぶ。`ensureManagerRun` はプロジェクトの登録と daemon の起動確認を行う。プロセス間で singleton を共有せず、保存済みキューと登録を起動要求として使う。旧 detached `takt run` と専用の環境変数は使用しない。

組み込み worker は論理的には一つで、名前は `builtin`。各プロジェクトのローカル処理は daemon の管理する子プロセスに委譲する。子プロセスは候補の返却、指定されたタスクの確定取得、実行、保存を担当する。独自の割り当てループや待機キューを持たない。daemon へ同期 I/O を持ち込まず、子入口を到達性検査のプロセス境界として宣言する。

割り当ての受け渡しは `TaskDispatcher.pull(workerName)` に統一する。worker adapter は空きがある間だけ pull し、dispatcher が両上限と既存割り当てを確認して確保した一件を受け取る。組み込みの `BuiltinWorkerAdapter` もこの境界を通った割り当てだけを host へ渡す。`builtin` の構成は daemon の組み立て箇所で指定する。後続のリモート通信も認証後に同じ pull 境界を利用し、ネットワークの受け渡しだけを別の adapter が担う。

根拠:

- `src/features/daemon/runDaemon.ts:164` が registry と共有 dispatcher を接続する。
- `src/features/daemon/taskDispatcher.ts:28` が pull を受け、開始前に両方の空きを確保する。
- `src/features/manager/autoRun.ts:35` が保存済みゴールと `manager.auto_run` を確認して daemon を要求する。
- `src/infra/worker-pool/projectHost.ts:20` が子プロセスとの要求・応答を管理する。
- `src/app/worker-pool-project/index.ts:1` が内部プロセス入口である。
- `scripts/daemon-reachability.mjs:22` がプロセス境界を宣言する。値 import から同期 API に到達する場合は引き続き禁止する。

### 設定と空き

グローバルの `config.yaml` に次を指定する。daemon 起動時に読み込む。

```yaml
daemon:
  builtin_worker:
    concurrency: 2
```

非負の安全な整数だけを受理する。0 なら通常タスクも PR マージ用タスクも組み込み worker へ渡さない。未指定ならプロジェクトごとの従来の `concurrency` をそのまま使い、あるプロジェクトの値を全体の上限へ流用しない。明示指定なら全プロジェクトで共有する組み込み worker の上限となる。どちらの場合もプロジェクトの上限を超えない。

`concurrency` と `ignore_exceed` は準備中・実行中の処理がなくなった後、次の候補を読む子プロセス内の境界でグローバル設定と解決済み設定のキャッシュを無効化して再解決する。プロジェクト設定の上書きを優先し、未指定なら更新後のグローバル値を使う。同じ解決結果を snapshot と実行 context に使う。準備中・実行中の設定変更は進行中の処理へ適用しない。daemon 側の組み込み worker 上限は起動時の値を保持する。設定解決は `src/features/workerPool/builtinProjectRuntime.ts:51`、既存の無効化は `src/infra/config/global/globalConfigCore.ts:318` にある。

worker の使用数は全リポジトリの実行中割り当ての合計、プロジェクトの使用数は当該プロジェクトの実行中割り当ての合計である。worker とプロジェクトの両方に空きがあるときだけ同じ dispatch 内で確保する。起動失敗、確定取得の拒否、実行終了で解放する。プロセスが異常終了した場合は、そのプロセスツリーの終了を確認してから解放する。実行待ちは daemon 側の pending に残す。

`src/core/worker-pool/scheduler.ts:3` が共通の判断を所有する。PR マージ用タスクは `builtin` だけを候補にする。後続実装では origin のないプロジェクトも同じ判断でリモートの候補から除く。ラベルによる振り分けは導入しない。

`daemon.builtin_worker.concurrency` の schema は `src/core/models/daemon-config-schema.ts:3`、非同期読込は `src/features/daemon/configuration.ts:16`、読込・直列化は `src/infra/config/global/globalConfigCore.ts:234` と `src/infra/config/global/globalConfigSerializer.ts:22` にある。

### 確定取得と排他

割り当ての決定だけではタスクを running にしない。ローカル子プロセスが既存 project lock を取り、provider の準備後に保存済み状態を再確認する。ゴール排他内で、指定タスクが pending、削除中でない、ゴールが一時停止・中止されていないことを検証し、execution ID、実行所有者、worker 名を running への遷移と同時に保存する。

`src/infra/task/taskLifecycleService.ts:253` の選択取得は既存の取得判定を共有する。`src/features/workerPool/builtinProjectRuntime.ts:134` が準備・取得・実行を接続する。`src/infra/task/project-execution-lock.ts:221` の PID と開始時刻を持つ project lock は手動 run/watch と共通である。準備中、実行中、終了保存中は lock を保持し、全実行の収束後に解放する。手動コマンドの競合時の理由表示を保持する。

pending の取り消しは既存の `takt_remove_goal_task` が担当する。候補を読み取った後に削除されても、選択取得で存在を再確認するため実行されない。子への送信待ちを新しいタスク状態にしない。

開始要求は実行開始、取得拒否、取得ロックの復旧待ち、準備失敗を区別して返す。後続タスクの準備失敗では新規取得を止め、実行中の別タスクの保存を待ってから後片付けを行う。組み込み runtime が所有する TaskStore は、ロック生成と所有者情報の書込中の ENOSPC を取得失敗として分類する。候補読込（中断回復を含む）、待機理由更新、開始前読込、確定取得に加え、読込不能入力の再確認と確定取得で使うゴール排他の取得失敗も同じ復旧期限を返し、IPC の要求を待たせ続けない。正常な空の候補や更新成功の応答で失敗を隠さない。

復旧期限は runtime が保持する。期限前の確認では延長せず、5秒後の実際の再取得でも容量不足なら次の期限を設定する。その間は新規割り当てを止め、実行中タスクの予約・所有権と host を保持する。開始しなかったタスクの予約だけを解放し、回復後は最新の pending とゴール状態を読み直す。provider 準備、取得後の本文保存・終端保存、必須通知、ロック解放の失敗はこの取得再試行へ含めない。host 自体の異常と明示停止では既存の中断・後片付け・排他解放順序を維持する。

読めるタスクを契機に自動実行が始まった場合、共存する読込不能な指示書も候補から除外しない。準備前の読込失敗はゴール排他内で再確認し、依然として読めなければ既存の終端生成処理で failed・failure・completion・run slug を保存して manager 完了イベントを発行する。再確認で読めた場合は pending に保ち、通常の provider 準備へ戻す。ゴール情報自体が読めない場合のスキップと、読込不能タスクだけでは新規起動しない条件は維持する。

選択取得は実行するタスク、取得拒否、同じ更新で保存した内容エラーの終端結果を区別して返す。終端結果は TaskStore の保存完了後の状態から返し、runtime がその結果を直接 manager の完了通知へ渡す。取得拒否後に通知のための追加一覧読込は行わない。単なる拒否では通知せず、保存済みの失敗結果を再保存・再採番しない。通知は取得失敗の再試行範囲から分離し、通知失敗を取得前へ戻さない。

### 保存と表示

`worker_name` と `waiting_reason` はタスクの説明項目であり、新しい status ではない。実行開始時に待機理由を消し、worker 名を保存する。再試行時は古い項目を消して次の割り当てで更新する。

`src/infra/task/taskRecordSchemas.ts:34` → `src/infra/task/mapper.ts:92` → `src/features/mcp/operations.ts:119` の経路で、一覧へ `workerName` / `waitingReason` を渡す。0 のときは実行可能な worker がない理由を表示する。明示した worker 上限またはプロジェクト上限を使用中なら空きを待つ理由を表示する。候補と設定の snapshot を読んだ後、割り当てと同じ判断箇所で理由を決め、別の IPC 操作で pending の説明を更新する。空きが戻れば再評価し、確定取得で理由を消す。通常の pending と同じ取り消し操作を利用できる。

### 入出力と既存操作

組み込み worker は既存の clone、指示書準備、workflow 実行、成果保存を使用する。`src/features/tasks/execute/runTaskExecution.ts:51` → `taskExecution.ts:122` が通常実行と保存済み PR マージ実行へ分岐する。結果をタスクへ保存した後に `saveManagerEvent` で完了を通知する。

ローカルの所有者は PID と開始時刻で識別する。終了していた実行は `failInterruptedTasksWithGoalEvents` で既存の中断結果へ回復し、自動で再実行しない。daemon との IPC 切断では新しい受付を止め、実行中処理へ abort を伝え、保存後に子を閉じる。保存自体のエラーでは成功した終了通知を送らず、子を終了させ、次の確認で既存の中断回復を使う。

子の終了時は既存の `terminateManagedProcesses` と `prepareSharedServerPoolForForcedShutdown` を使い、管理下のコマンドや provider の共有サーバーを終了させる。実行の収束と後片付けの両方を待ってから project lock を解放する。停止中の状態の保存に失敗しても後片付けは実行し、失敗を呼び出し側へ返す。

run の読み先は `src/features/mcp/operations.ts:105` の clone 所有権検証を保持する。`takt_get_run` はその run の段階、ログ、レポートを読む。`takt_tell_run` は `src/features/tasks/liveIntervention.ts:118` の既存指示保存を使う。停止要求は execution ID と生存所有者を検証して保存し、`src/features/tasks/execute/goalAbortMonitor.ts:49` が停止・一時停止・中止を実行へ伝える。停止要求だけで running を終端にせず、収束と保存の後に停止した理由を持つ失敗へ遷移する。requeue/retry の再開位置、作業場所、追加指示の意味も既存処理を保持する。

## リモートの登録と通信（後続実装）

worker の管理は daemon マシン上の `takt worker add/list/remove` だけが行う。登録は worker 名、登録世代、concurrency、トークンの検証用ハッシュを保存する。暗号学的乱数のトークン平文は登録時の端末に一度だけ出力し、設定、ログ、run 記録へ保存しない。list は名前と concurrency を表示し、トークンは表示しない。

worker は URL とトークンだけを持ち、外向きに接続する。接続要求は TAKT バージョンと protocol version、worker の登録識別子を含める。localhost 以外の平文 HTTP、不明・削除済みトークン、異なる TAKT バージョンはタスクや認証情報を送る前に拒否し、worker は理由を表示して終了する。HTTPS の終端はリバースプロキシか VPN が担当する。TAKT 自身の TLS は作らない。

通信は認証済みの継続接続で行う。メッセージは `protocolVersion`、`requestId`、`workerId`、`registrationGeneration` を持つ。worker は空きがあるときだけ `pull` を送る。daemon は保存済みの割り当てを確認し、空きの判断と割り当ての保存を済ませて一件ずつ返す。worker に実行待ちタスクを積まない。同じ request ID の再送には同じ結果を返し、重複取得しない。

割り当てレコードは次を持つ。task status とは別の制御情報とする。

| 項目 | 意味 |
|---|---|
| project ID / task name | daemon のどのキューのタスクか |
| worker ID / name / registration generation | 接続と登録の識別 |
| execution ID / assignment generation | タスクの一回の実行と単調増加する割り当て世代 |
| original SHA / origin / branch | 再現するコードと受領対象 |
| lease expires at | daemon が決める有効期限 |
| last acknowledged log sequence / control sequence | 再送と制御の重複排除 |
| work location / retry reservation | 同じ worker 上での再開と空き予約 |

すべての記録・制御・完了要求に上記の割り当て識別子を付ける。daemon は現在の登録と割り当てに一致し、有効期限内の要求だけを受理する。登録削除は登録世代を無効化し、接続を閉じ、実行中タスクを登録削除の理由で失敗にする。それ以降の push が origin に存在しても受領・取り込みを許さない。

## リモートの入力と成果（後続実装）

入力はコードの固定 SHA と、それ以外の実行資産を分ける。daemon はローカルにしかない元ブランチを origin へ push して SHA をタスクに保存する。worker は origin からその SHA を取得・検証して clone を作る。origin のないタスクと PR マージ用タスクは組み込みだけへ割り当てる。

実行資産には指示書、添付の相対パスと内容、daemon で解決した設定、workflow と参照先、facet、再開モードを含める。ファイルの長さ・ハッシュと実行資産の版を付け、受領側でパスの境界、完全性、必要な参照を検証する。worker のローカル設定や workflow を混ぜない。認証情報はこの保存可能な入力とは別のメモリ上の内容として渡す。

出力は成果ブランチ、成果 SHA、run slug、実行結果、記録の最終 sequence とする。worker は origin へ push した後に完了を通知する。daemon は割り当ての有効性を検証し、origin から成果を fetch して SHA を比較する。記録を受領し、fetch した SHA が一致してからタスクを完了にして manager へ通知する。fetch 失敗・SHA 不一致ならその理由で失敗にし、完了にも取り込み可能な成果にもしない。`takt_merge_goal_task` は検証済み SHA のみをゴールブランチへ取り込む。

組み込みは既存のローカル clone と取り込みを維持するためネットワーク転送を模倣しない。共通の dispatcher とタスク実行契約の下で、資産の搬送と所有者の確認を実行方式に応じて実装する。

## リモートの記録・制御・接続復旧（後続実装）

run 記録は daemon の当該プロジェクトの `.takt/runs/<run slug>/` に既存形式で集約する。worker はファイルごとの offset と単調増加 sequence を付けて送信し、daemon は永続化後に ACK する。worker は ACK まで再送用記録を保持する。再接続時は最終 ACK から再送し、重複は同じ内容であることを確認して除外する。欠番を飛ばさない。成果受領は最終 sequence の永続化を待つ。

リモート run の読み先は保存済み割り当てから daemon の集約先へ解決する。ローカル clone の存在やリモート worker のパスを使わず、`takt_get_run` が実行中・切断中・失敗後の既受領の段階、ログ、レポートを読めるようにする。組み込みでは既存 clone 所有権検証を保持する。

追加指示、停止、一時停止、中止は割り当てと control sequence に結び付く要求として永続化して送る。worker は受信と反映を ACK し、run 記録へ受領を残す。追加指示は既存の指示保存へ、一時停止と中止は既存の abort と結果保存へ接続する。停止したことを受領するまでは running を保持する。古い execution ID や世代への制御を新しい実行へ適用しない。

heartbeat 間隔は5秒、再接続の猶予と lease は最後の正常確認から60秒とする。組み込みの生存確認にこの時刻判定を流用せず、ローカル PID・開始時刻とリモート接続・lease を区別する。

切断の猶予内は running と割り当てを保持する。再接続で登録、execution ID、世代が一致すれば継続し、欠けた記録と未 ACK の制御を再送する。猶予を超えたら切断理由で失敗として記録し、自動で別 worker へ渡さない。失敗後の再接続には停止を返し、遅れて届いた完了や成果を拒否する。

daemon の再起動では永続化した割り当て、lease、記録の ACK、制御の ACK を復元する。停止時間を含む元の期限まで再接続を待ち、期限内なら running のまま続ける。期限を延ばし直さない。期限を超えた割り当ては切断失敗とし、途中まで受け取った run 記録は残す。

## リモートの失敗予約と再試行（後続実装）

失敗したタスクは元 worker の空きを一つ予約する。予約は worker の使用数だけに加え、プロジェクトの使用数には加えない。pending の別タスクはその空きを使えず、一覧に予約しているタスクと worker を表示する。今回の組み込み置換では従来の失敗後の空き解放を保持する。

requeue/retry は保存済み worker と作業場所を参照する。元 worker が接続中で作業場所が残っていれば、予約した空きで既存の再開処理を使う。プロジェクトの空きは通常の pending より先にこの再試行へ割り当てる。remove は予約を解放し、元 worker の作業場所の削除を ACK で確認する。ゴール中止でも予約を解放する。

元 worker の登録が削除済みなら待たず、切断中なら上記60秒の猶予まで待つ。戻らない場合は予約を解放し、別 worker の空きを使って記録済みの元 SHA から最初から実行する。新しい execution ID と世代を発行し、元 worker が使えない理由と最初からやり直したことを manager が読める記録へ残す。途中の作業場所や再開 checkpoint を別 worker へ移さない。元 worker 上の作業場所が失われた場合も途中からの再開は成立しないため同じく最初から実行し、作業場所がない理由を記録する。

## リモートの認証情報（後続実装）

worker の接続用トークンとタスク用の認証情報を分離する。接続用トークンは worker の通信処理だけが持ち、タスクのプロセスへ渡さない。daemon が配布対象として明示した Git、gh、provider の認証情報を、タスクごとの子プロセス環境へ重ねる。daemon に該当する認証情報があれば優先し、なければ worker マシンの既存認証を使う。worker 自身や同時実行中の別タスクの環境変数を変更しない。

Git トークンを clone URL や保存 Git config に埋め込まない。認証 helper は専用プロセスの環境から読み、`GIT_CONFIG_COUNT` と `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` によるプロセス限りの指定を使う。gh は該当ホスト用の `GH_TOKEN` / `GITHUB_TOKEN`、provider は各 provider が認識する環境へ渡す。設定ファイルへ認証を生成・保存する provider については書き込まない方式を確認してから対応する。

現行の `src/infra/task/git-environment.ts:10` は危険な Git 設定を除去し、コマンドの環境で hooks / filters を制限する。`src/shared/utils/child-process-env.ts:24` は子プロセスへ渡す環境のコピーを作る。この安全処理を失わず、daemon の認証を最終的な優先値として渡す。認証内容を含む入力をディスク、ログ、run 記録へ保存しない。エラーや出力は配布した秘密値も含めて除去してから記録・転送する。認証不足の失敗には provider と worker 名を含めるが秘密値を含めない。配布済み Git トークンそのものの失効は範囲外である。

## 要求シナリオとの対応

指示書の Scenario Outline は Examples の全行を同じ節の契約で扱う。

| シナリオ | 対応節 | 実装担当 |
|---|---|---|
| --resident で起動した daemon は仕事がなくても止まらない | 範囲 | resident 別タスク |
| --resident の daemon は TUI を閉じても止まらない | 範囲 | resident 別タスク |
| --resident の daemon は停止の指示で止まる（stop / SIGTERM） | 範囲 | resident 別タスク |
| --resident の daemon はバージョンの違う manager に入れ替えられない | 範囲 | resident 別タスク |
| オプションなしの daemon は今と同じく仕事がなければ止まる | 範囲・dispatcher と組み込み worker | 既存動作を保持 |
| daemon のマシンで worker を登録するとトークンが端末にだけ表示される | リモートの登録と通信 | 後続 |
| 正しいトークンの worker は URL とトークンだけで daemon につながる | リモートの登録と通信 | 後続 |
| つなぐことを許されない worker は断られる（未登録・削除済み・版違い・平文 URL） | リモートの登録と通信 | 後続 |
| 実行中に登録を消すと worker は切り離され、その後に届いた成果は使われない | リモートの登録と通信・入力と成果 | 後続 |
| worker を登録していなければ組み込みの worker が今と同じく実行する | 設定と空き | 今回 |
| 組み込みの worker の concurrency が 0 のとき daemon のマシンでは実行しない | 設定と空き・保存と表示 | 待機は今回、リモート接続後は後続 |
| PR のマージ用のタスクは組み込みの worker だけで実行される | 設定と空き | 今回、リモート対向は後続 |
| 同時に動くタスクは worker の concurrency とプロジェクトの concurrency の両方で抑えられる（指定4組） | 設定と空き | 偽 worker の検証は今回 |
| 複数のリポジトリのタスクは同じ worker pool で動き、それぞれの上限で抑えられる | 設定と空き | 偽 worker の検証は今回 |
| 同じプロジェクトで takt run / takt watch と取り合わない | 確定取得と排他 | 今回 |
| daemon のキューで待っているタスクは取り消せる | 確定取得と排他 | 今回 |
| タスクの一覧にどの worker で動いているかが出る | 保存と表示 | 組み込みは今回 |
| リモートの worker はコードを origin から、それ以外を daemon から受け取る | リモートの入力と成果 | 後続 |
| daemon が成果を受け取ってからタスクを完了にする | リモートの入力と成果 | 後続 |
| 成果を取得できない、または SHA が合わないときは完了にしない | リモートの入力と成果 | 後続 |
| origin のないリポジトリのタスクは組み込みの worker だけが実行する | 設定と空き・リモートの入力と成果 | 後続のリモート適格性判定 |
| リモートの worker の run の記録は daemon に集まる | リモートの記録・制御・接続復旧 | 後続 |
| 追加指示、停止、ゴールの一時停止と中止はリモートの worker に届く | リモートの記録・制御・接続復旧 | 後続 |
| ゴールの状態の変化がリモートのタスクに届く（pause / abort） | リモートの記録・制御・接続復旧 | 後続 |
| worker との接続が戻らなければタスクは失敗として記録され、そこまでの記録は残る | リモートの記録・制御・接続復旧 | 後続 |
| 失敗として記録したあとに接続が戻った worker はそのタスクを止め、成果は使われない | リモートの記録・制御・接続復旧 | 後続 |
| 接続が定めた時間の内に戻ればタスクは続く | リモートの記録・制御・接続復旧 | 後続 |
| daemon を起動し直してもリモートで実行中のタスクの扱いが崩れない | リモートの記録・制御・接続復旧 | 後続 |
| 失敗したタスクのために、失敗した worker の空きを 1 つ取っておく | リモートの失敗予約と再試行 | 後続 |
| 失敗したタスクを戻すと同じ worker で途中から再開する（requeue / retry） | リモートの失敗予約と再試行 | 後続 |
| 失敗したタスクを片付けると空きを手放し、作業場所を消す | リモートの失敗予約と再試行 | 後続 |
| ゴールを中止すると取っておいた空きを手放す | リモートの失敗予約と再試行 | 後続 |
| 元の worker がいなければ別の worker で最初からやり直す（削除済み / 切断） | リモートの失敗予約と再試行 | 後続 |
| daemon に集めた認証情報はタスクのプロセスにだけ渡り、TAKT はディスクに書かない | リモートの認証情報 | 後続 |
| daemon が持っていない認証情報は worker のマシンのものを使う | リモートの認証情報 | 後続 |
| 両方にあるときは daemon から渡した認証情報を使う | リモートの認証情報 | 後続 |
| 認証情報が足りない worker での失敗は理由と worker が分かる | リモートの認証情報 | 後続 |
