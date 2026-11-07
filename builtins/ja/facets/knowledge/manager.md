# TAKT manager

## 会話と状態

TUI は相談、登録案の承認、質問回答、状態操作、表示を扱います。/make-goal は会話から登録案を作り直す操作で、登録そのものではありません。↑ 登録する / ↓ 登録せずに会話に戻る / Enter 確定で案を操作します。会話に戻るか修正内容を入力すると、案は取り下げられます。summary がない応答には登録案を出しません。Ctrl+R は未回答の問い合わせ、Ctrl+G は進行中のゴールです。処理中も使えます。/ の補完は Tab で確定し、/make-goal 以外の / 入力は通常の発言です。

会話ごとの常駐子プロセスがターン準備、AI、MCP、業務操作を担当し、daemon は受付・保存・配送・監視を担当します。人の入力と他のイベントの二本のキューがあり、次のターンでは人の入力を優先し、各キューは受付順です。同じ会話は直列で、一つのセッションにイベントの知識も残ります。accepted は永続化済みの受付で、成功ではありません。処理中の入力保存、読み出し、中断が可能で、中断しても待機入力は残ります。子の異常終了は失敗を記録し、ターンを盲目的に自動再送しません。manager は現在状態を調べて復旧を判断できます。

一つの manager は workspace で複数リポジトリを担当できます。どの所属リポジトリからも同じ会話が開きます。一つのゴールは一つの担当リポジトリで進み、未完成のゴールがあれば担当を外せません。登録は TUI / Slack の登録案の承認で行います。状態操作は必要な MCP 能力を持つ全 provider に公開されます。

## 道具と復旧

ゴール操作は対象の cwd と goalId を使います。引数定義を確認してください。takt_list_tasks は goalIntegration（integrated / not_integrated / unknown / direct_push）と、不明な理由を goalIntegrationReason に返します。direct_push は PR のブランチへ直接 push するタスクを表し、取り込み成功を意味しません。成功表示だけで取り込み済みと判断しません。

- takt_get_workflow は takt_list_workflows で選んだ名前・scope reference・パスを workflow に受け、説明と段階の名前・説明・種類、wait、system_inputs、effects、rules の条件と遷移先を返します。workflow_call の呼び先は親の文脈で解決した名前・場所と、続けて読むための getInput を返します。getInput の workflow と callPath をそのまま渡すと、呼び出し引数も保って辿れます。応答は 64 KiB 以内で、省略を明示します。段階は offset / limit で続きを読めます。
- takt_enqueue_goal_task は名前・scope reference・パスの workflow を使い、ゴールブランチを基点に worktree で実行します。autoPr と shouldPublishBranchToOrigin は省略時 false で、投入時に指定できます。merge_pr / close_pr を含む workflow も使えます。
- takt_requeue_goal_task は failed / exceeded を保存位置から続けます。failed には startStep も選べます。exceeded の startStep 指定はできません。保存位置が使えなければ理由と候補が返ります。
- takt_retry_goal_task は指示を直して同じ failed タスクを pending に戻します。分け方や作業を変える場合は新規投入を使います。
- takt_remove_goal_task は理由付きで pending を取り消し、停止済み・取り込み済み成果を片付けます。一時停止中の pending 取消も可能です。未取り込みの完了成果は discardUnmerged: true で明示破棄できます。実行中は削除できず、cleanup 失敗は成功扱いしません。
- takt_stop_goal_task は goalId、taskName、executionId と生存 PID を照合して停止要求を保存します。保存済み開始時刻があれば現在の時刻との一致も必要です。worker が要求を観測して停止し、終了までは running が残ります。
- takt_tell_run は実行中タスクに cwd、goalId、taskName、content で追加指示を送り、原文を作業記録に保存します。
- takt_pause_goal / takt_resume_goal / takt_abort_goal は cwd、goalId を使い、中止には理由が必要です。一時停止は進行中の実行を止め、新しい実行や該当イベントを保留します。停止タスクは `Goal <id> was paused` の失敗として残り、run 開始前なら位置や run がないこともあります。再開後に状態を見て同じタスクを続けられます。中止は未実行を無効化し、実行中を中断します。中止は終端状態で、記録・ブランチは残ります。完成済みには状態操作できません。
- takt_list_standalone_inquiries は現在の担当のゴールなしの未回答だけを読みます。takt_withdraw_standalone_inquiry は id と理由で未回答を取り下げ、回答済みは変えません。

manager の自動 run は auto_run を守り、ゴールタスクだけを実行します。二重起動を防ぎ、ゴール run の自動再試行は 0 回です。manager が復旧を判断します。道具使用後に失敗したターンは自動再送しません。

## 取り込みと PR

成果をゴールブランチへ集めてから取り込み先へ反映します。manager.main_merge はプロジェクト設定だけを使います。approve と auto はどちらも PR を作ります。既定の approve は until: prepare のマージ用タスクで仕上げて人のマージを待ちます。auto は人が設定した継続の取り込み指示として、until: merge で仕上げからマージまで進めます。

takt_complete_goal は確認した expectedSha、証拠付き summary と、PR が必要なら humanChecks を使います。awaiting_merge ではブランチを push し、保存された取り込み先を base に PR を作成または再利用します。GitHub、origin、既存 PR の head/base を照合し、番号と URL を pullRequest に保存します。push や PR 準備に失敗して PR 未保存なら、原因解消後に takt_complete_goal を呼び直せます。manager 自身も push の状態を調べ、必要な修正・再実行を行えます。

takt_merge_goal_pr は必須の cwd、goalId、保存 PR に一致する prNumber、until を受け、ゴール所属のマージ用タスクを pending で積み、タスク名をすぐに返します。CI が走っている途中でも積んでよく、事前に完了を待つ必要はありません。until: prepare は merge-prepare、until: merge は merge.workflow（未設定なら merge-review-fix-simple）を使います。同じ対象の pending / running タスクは重ねません。保存 PR、awaiting_merge、停止状態を検査します。タスクは PR のブランチに直接 push し、手元のゴールブランチが祖先なら fast-forward します。分岐やチェックアウト中の作業コピーは上書きせず、結果と完了イベントに残します。結果は prepared、merged、unresolved を区別します。マージ済みなら takt_check_goal_completion で完成を確かめます。保存 PR の head/base が一致していれば squash や追加コミットにも対応します。未マージで closed なら完成しません。PR を確認できない取り込み待ちは内容を比較し、完成証拠と PR を保持して created に戻した場合も確認できます。 until: merge で積んだタスクも、ワークフローが COMPLETE で終わって PR が未マージなら成功・prepared として届くため、manager は結果を読んで次の対応を判断します。

## 記憶・問い合わせ・通知

記憶は objective、outOfScope、acceptanceCriteria、constraints、workLog、質問と回答です。現在状態はタスク、run、Git で確認します。takt_record_goal_work_log は会話からも記録でき、旧 kind: patrol は点検だけで進捗ではありません。

人は TUI の Ctrl+R や Slack の問い合わせスレッドで質問・操作依頼に回答します。回答の出所と型を保存し、manager は人の代わりに回答しません。旧来の承認記録は読み取り・取り下げ用に残り、実行可否には使いません。完成・中止時の問い合わせはコードが閉じ、一時停止では残します。

manager.notifications は question / awaiting_merge / completed / progress / blocked / custom を種類ごとに切り替えます。質問の回答画面は通知無効でも残ります。通常画面の通知は冒頭だけ表示し、起動前の通知は再表示しません。全文や過去の通知はゴール記録から読みます。通知失敗はログに残して作業を続けます。

見張りはプロセス消失、PR 状態変化などの変化・異常だけを配送し、時計だけで AI を呼びません。生存や開始時刻が不明なら死亡と決めません。takt_get_run は currentIteration、currentStepStartedAt、currentStepExecutionCount、終了段階の timestamp / iteration を返します。対応する保存ログがなければ開始時刻は不明です。
