# TAKT manager

## ゴール、タスク、成果

一つの manager は workspace で複数リポジトリを担当できます。一つのゴールは一つの担当リポジトリで進みます。担当解除は、所属ゴールがそれぞれ完成済みまたは中止済みのリポジトリで成立します。

タスクの終了、成果のゴールブランチへの取り込み、PR のマージ、ゴールの完成は、それぞれの操作と状態で記録されます。accepted は受付済み、タスクの成功は実行結果を表します。取り込み状態は takt_list_tasks の goalIntegration（integrated / not_integrated / unknown / direct_push）に返り、unknown の理由は goalIntegrationReason に返ります。direct_push は PR ブランチへ直接 push するタスクを表します。

ゴールは TUI または Slack の登録案を人が承認すると登録されます。/make-goal は会話から登録案を作り直します。

## 実行とイベント

一時停止は実行と後続イベントを保留し、中止は終端状態です。再開すると待機中のタスクも実行可能になります。保存されたタスクの指示は、指示変更の操作によって更新されます。

タスク終了、人の回答、保存 PR のマージ・クローズ・取り込み先との衝突はイベントで届きます。定期見回りは対象となる活動中のゴールをまとめて扱います。awaiting_merge でも、そのゴールに結び付いたマージ用タスクが pending または running なら見回ります。人のマージを待つだけのゴールは見回りから外し、PR の見張りが担当します。

標準の PR 仕上げワークフロー（merge-prepare / merge-review-fix-simple）は、取り込み先の取り込み、衝突の解消、レビュー、CodeRabbit への対応、CI 待ちを担当します。カスタム merge.workflow のレビューや CI 待ちは、定義された段階に従います。CI の実行中にもタスクを投入できます。結果は prepared、merged、unresolved を区別し、PR の状態とともに返ります。

manager.main_merge はプロジェクト設定から解決されます。approve と auto はどちらも PR を作ります。approve は until: prepare で仕上げ、人のマージを待つ方式です。auto は人が設定した継続の取り込み指示として、until: merge で仕上げからマージまで進める方式です。

同時実行上限は、プロジェクトの run / watch 全体で共有する数です。manager の自動 run は auto_run に従ってゴールタスクを実行し、自動再試行回数は 0 回です。実行の二重起動はロックで調整され、復旧は保存された状態から manager が判断します。道具使用後に失敗したターンは失敗として保存され、その後の復旧も manager が判断します。

## 道具と復旧

ゴール操作は対象の cwd と goalId を使います。各道具の引数と返却値は公開された定義に従います。

- takt_get_workflow は、名前・scope reference・パスを workflow に受け、段階の名前・説明・種類、wait、system_inputs、effects、rules を返します。workflow_call は解決済みの呼び先と getInput を返し、getInput の workflow と callPath で続けて辿れます。応答は 64 KiB 以内で、省略部分は offset / limit で取得できます。
- takt_enqueue_goal_task は、ゴールブランチを基点に worktree で実行するタスクを積みます。autoPr と shouldPublishBranchToOrigin の既定値は false です。workflow は名前・scope reference・パスで指定でき、merge_pr / close_pr を含むものも対象です。
- takt_requeue_goal_task は failed / exceeded を保存位置から続けます。failed は startStep も指定でき、exceeded は保存位置からの再開を使います。保存位置の利用可否、理由、開始候補が応答に返ります。
- takt_retry_goal_task は指示を更新し、同じ failed タスクを pending に戻します。
- takt_remove_goal_task は理由を受け、pending の取消や停止済み・取り込み済み成果の片付けを行います。一時停止中の pending も取消対象です。未取り込みの完了成果の破棄には discardUnmerged: true を使います。実行中タスクの停止には takt_stop_goal_task を使います。cleanup の失敗は操作結果に現れます。
- takt_stop_goal_task は goalId、taskName、executionId、生存 PID を照合して停止要求を保存します。保存済み開始時刻も照合に使われます。worker が要求を観測して停止し、それまでは running が残ります。
- takt_tell_run は cwd、goalId、taskName、content で追加指示を送り、原文を作業記録に保存します。
- takt_pause_goal / takt_resume_goal / takt_abort_goal は cwd、goalId を使い、中止には理由を受けます。一時停止で止まったタスクは `Goal <id> was paused` の失敗として残り、開始前なら位置や run の情報が空の場合もあります。再開後は保存状態に応じて同じタスクを続けられます。中止は未実行を無効化し、実行中を中断して記録とブランチを保持します。completed は完成済みの記録として参照します。
- takt_list_standalone_inquiries は現在の担当のゴールなしの未回答を返します。takt_withdraw_standalone_inquiry は id と理由で未回答を取り下げ、回答済みの記録を保持します。

## 取り込みと PR

通常タスクの成果はゴールブランチへ集め、そこから取り込み先へ反映します。

takt_complete_goal は expectedSha、証拠付き summary、PR 用の humanChecks を受けます。awaiting_merge ではブランチを push し、保存された取り込み先を base に PR を作成または再利用します。GitHub、origin、PR の head/base を照合し、pullRequest に番号と URL を保存します。取り込み先に内容が未反映なら、PR 保存済みの同じ SHA の再申請で completion の summary と PR 本文を更新できます。PR 未保存で準備を再試行する場合、保存済み humanChecks を優先します。入力した値は未保存欄の補完にだけ使い、その場合は保存済み summary を維持します。humanChecks を省略すれば保存済み値を再利用し、入力 summary を保存できます。保存値も入力値もない場合は、PR 準備前にエラーになります。再申請前にゴールブランチ先端を確認して検証し、保存済み goalSha から進んでいれば新しい先端を確認し直し、その expectedSha、summary、humanChecks で再申請します。既存 PR 本文の読み取りや更新だけが失敗した場合、保存 PR は保持され pullRequestBodyError が返ります。

保存済みの完成記録を訂正・確認する方法は、申請済み SHA と現在のゴールブランチ先端に応じて選びます。

- 再申請前にゴールブランチ先端を確認して検証します。先端が申請済み SHA から進んでいれば、新しい先端を確認し直し、新しい expectedSha、summary、humanChecks で takt_complete_goal に再申請します。申請済み SHA が取り込み先に反映済みの場合も同じです。
- 先端が申請済み SHA のままで、その SHA が取り込み先に未反映の場合は、保存済みの根拠を訂正するために takt_reopen_goal に理由を渡して created へ戻し、確認済み expectedSha、訂正済み summary、humanChecks で takt_complete_goal に再申請します。
- 申請済み SHA が取り込み先に反映済みで、現在のゴールブランチ先端も同じ SHA の場合は、同じ expectedSha と訂正済み summary で takt_complete_goal を呼び、根拠を訂正します。反映済み SHA に takt_reopen_goal は使いません。
- 申請済み SHA が取り込み先に反映済みで、根拠の訂正が不要な場合は、takt_check_goal_completion で完成を確認します。

takt_merge_goal_pr は cwd、goalId、保存 PR に一致する prNumber、until を受け、マージ用タスクを pending に積んでタスク名を返します。until: prepare は merge-prepare、until: merge は merge.workflow（既定は merge-review-fix-simple）を使います。保存 PR、awaiting_merge、停止状態が照合されます。

マージ用タスクは PR ブランチへ直接 push します。手元のゴールブランチが祖先なら fast-forward し、分岐やチェックアウト中の作業コピーは元の内容を保持して結果に記録します。workflow が COMPLETE で終わり、PR が準備段階にある場合は、成功・prepared として届きます。

takt_check_goal_completion は保存 PR の head/base とマージ状態を照合し、squash や追加コミットを含む完成確認に対応します。保存 PR が CLOSED の場合は included: false を返します。PR 状態に応じて取り込み先との内容比較も使います。completion とマージ済み PR を保持した created のゴールも確認対象です。完成時は status を completed に更新し、対象の問い合わせを閉じます。

## 会話、記録、問い合わせ

会話ごとの常駐子プロセスがターン準備、AI、MCP、業務操作を担当し、daemon が受付・保存・配送・監視を担当します。人の入力とその他のイベントは別々のキューに入り、次のターンでは人の入力が優先されます。各キューは受付順、同じ会話は直列です。中断時も待機入力は保存されます。

保存される情報は objective、outOfScope、acceptanceCriteria、constraints、specifications、workLog、質問と回答です。takt_record_goal_work_log は会話からも記録でき、kind: patrol は点検の記録を表します。

人は TUI の Ctrl+R や Slack の問い合わせスレッドで回答し、回答の出所と型が保存されます。旧承認記録は過去の記録の参照・取り下げに使われます。完成・中止時は問い合わせが閉じ、一時停止時は保持されます。

TUI は相談、登録案の承認、回答、状態操作、表示を扱います。登録案は矢印キーと Enter で操作でき、会話に戻るか修正内容を入力すると案が取り下げられます。Ctrl+R は問い合わせ、Ctrl+G は進行中のゴールを開きます。処理中も利用でき、/ の補完は Tab で確定します。/make-goal と /verify は会話のコマンドとして扱われ、その他の / 入力は発言として扱われます。summary を持つ応答から登録案が表示されます。

manager.notifications は question / awaiting_merge / completed / progress / blocked / custom を種類ごとに切り替えます。問い合わせの回答画面は保存済みの質問から利用できます。通常画面は起動後の通知の冒頭を表示し、全文や過去の通知はゴール記録から参照できます。通知の配送結果はログに保存されます。

## 見張りと仕様の検証

見張りはプロセス消失や PR 状態の変化を配送します。プロセスの生存と開始時刻を照合して状態を判定します。takt_get_run は currentIteration、currentStepStartedAt、currentStepExecutionCount、終了段階の timestamp / iteration を返し、開始時刻は対応ログの有無に応じて値または不明として扱われます。

取り込み先との衝突は pr_conflicting で届きます。同じ衝突の通知は状態の変化に対応し、解消後の再発も通知対象です。mergeable の UNKNOWN は判定保留の状態です。

specifications は任意の保存フィールドです。takt_get_goal の path に specifications.gherkin、specifications.quint、specifications.alloy を指定すると各本文を取得できます。PR の最終レビュー用タスクには保存仕様が自動で渡ります。

形式仕様が有効な場合、人が TUI または Slack の会話で /verify を送ると、現在の合意から仕様を生成して検査し、結果を同じ会話へ返します。保存済みのゴールと仕様は検証前の内容で保持されます。形式仕様の設定に応じて、検証の利用可否が応答に返ります。
