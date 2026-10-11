# TAKT の使い分け

## 実行のしくみ

投入した作業は、実行開始時点のゴール用ブランチの先端をもとに始まる。
同時実行数の上限は system prompt の Concurrency limit の行に示される。このプロジェクトの run / watch に適用される上限で、空いている枠の数ではない。ほかのゴールと通常のタスクも同じ枠を使い、上限を超えて投入された作業は空きを待つ。
ゴールに所属するタスクには、自動再投入とPR作成後のcacciaは適用されない。
終了すると、結果、branch、SHA、中断の有無、失敗理由、runの識別子を含むイベントが保存される。イベントのたびに新しいセッションで判断する。未処理のイベントは後で読み直して処理される。

## ツールと保存状態

ゴール一覧・詳細、タスク一覧、runの詳細から、保存された状態と成果を読める。
workflow 一覧は候補とその説明を返す。ゴールへの作業投入はゴールIDと作業目的を保存し、禁止されている system effect が含まれないか、呼び先も含めて検査する。
成果の確認には takt_get_goal_diff（ゴールとタスクの差分一覧、増減行数、指定ファイルの差分）、takt_get_goal_history（件数に上限がある履歴）、takt_get_goal_relation（成果が取り込み先に含まれるかどうかと、ゴール側で追加されたコミット数）を使う。結果の一部が省略されている場合は完全な根拠にならない。必要なファイルを指定して補える。

takt_merge_goal_task は goalId、taskName、expectedSha を受け取る。保存されたタスクの所属と現在のSHAを検査し、ゴール用ブランチへマージして、その作業の結果を保存する。成果が要求を満たすかどうかは manager が判断する。取り込み先がチェックアウト中ならその場所を返し、コンフリクトならマージを中断して競合ファイルを返す。人の作業ツリーは変更しない。

takt_complete_goal は goalId、expectedSha、summary（満たした受け入れ条件と根拠）を受け取る。リポジトリの manager.main_merge は auto / approve で、既定は approve。auto は設定された取り込み先へ反映して完成にする。approve、または取り込み先がチェックアウト中の auto は、対象ブランチ・SHA・概要・手順を保存し、人の取り込みを待つ。summary は受け入れ条件と根拠を表す。変更概要はツールが差分から別項目の changeSummary に生成する。truncated はファイル一覧の省略、totalsTruncated は集計も不完全であることを示す。人には概要と保存された worktrees・手順を伝える。
takt_check_goal_completion は、人の取り込み後に保存された対象SHAが取り込み先に含まれるかを検査し、完成にする。現在のゴールの先端を承認対象へすり替えない。recorded が false の場合は、実際の操作結果と保存エラーを区別して再確認・再記録する必要がある。完成したゴールには新しい作業を投入できない。
要約は保存され、TUIの起動時または次の発言時に表示される。

## 質問と通知

takt_ask_goal_question は goalId、body と、任意の options・recommendation・dependentWorkKeys を保存し、questionId を返す。takt_list_goal_questions と takt_get_goal_question で pending / answered / withdrawn の状態と回答内容を読める。takt_withdraw_goal_question は回答待ちの質問を取り下げる。takt_enqueue_goal_task の workKey が回答待ち質問の dependentWorkKeys に一致すると、保存前に質問ID付きで投入を拒否する。キーを指定しない作業や、一致しない作業は止まらない。
人はTUIの /answer 質問ID から、矢印キーとEnterで選択肢または自由記述を選ぶ。回答は source: tui と時刻を伴って保存され、共通 events の kind: answer・questionId・answer として新しいイベントターンへ届く。ターンが失敗した場合は、同じ未処理イベントから処理をやり直す。
takt_notify_goal は goalId、kind（blocked / custom）、body と、任意の severity（info / warning / error）を受け取る。質問の保存、作業の取り込み、awaiting_merge / completed への遷移は自動通知される。manager.notifications の question / awaiting_merge / completed / progress / blocked / custom は種類ごとのbooleanで、既定ではすべて有効。無効にするとTUIの出来事の表示とSlack通知に適用されるが、質問の表示と依存する作業の制御は残る。保存後にコードがSlackへ送信し、Webhookが未設定なら送信しない。送信の失敗は診断として記録され、作業は継続する。

## 一時停止と中止

進捗 status と実行状態 executionStatus は独立している。人はTUIの1行のコマンド /pause <goalId>・/resume <goalId> で active と paused を切り替える。ゴールIDは必須で、一時停止中のゴールは現在の表示で識別できる。停止・再開を行うMCPツールはない。停止・再開の際も、取り込み待ちの completion・SHA・手順は保持される。
paused のゴールへの投入・再投入・取り込み・完成・完成確認は、理由付きのエラーになる。pending のタスクは取得されずに残る。通常のタスクとほかのゴールは引き続き取得される。実行中のタスクは最後まで実行され、終了結果と回答イベントは保存されるが、paused の間は manager ターンが延期される。
再開後は保存された未処理イベントを処理する。イベントがなくても、既存の auto_run、実行内容を決める処理、run/watch をどのプロセスが管理しているかに関する条件で、自動起動を判断する。paused のタスクがあるだけでは自動起動しない。

中止したゴールにもイベントは保存されるが、manager は呼ばれない。人は /abort <goalId> の確認で active・paused から aborted にできる。IDは必須で、既定の選択はキャンセル。中止は取り消せない。中止したゴールは現在の表示でも再起動後でも識別でき、aborted からの再開は拒否される。
そのゴールに所属する pending のタスクだけを、理由とともに再試行できない failed として保存し、タスクの取得と自動起動から除外する。pending の更新に失敗しても aborted は保持され、もう一度確認操作を行って更新できる。
自動 run と直接起動した run/watch の実行中タスクは、保存状態を定期的に読み、そのゴールに所属するタスクの signal だけを中断する。中止は即時とは限らず、paused では中断しない。中断理由、runの識別子、終了結果を保存する。中止後の投入・再投入・取り込み・完成・完成確認は、保存された結果を再利用する前に拒否される。中止のMCPツールはない。受け入れ条件は登録時に版1となる。

## 操作と判断の記録

判断記録には選択・理由・根拠が保存され、operations には操作の pending / completed 状態と結果が保存される。投入・取り込み・完成・質問・通知・質問の取り下げ・完成確認は、イベントの操作名を使って再試行できる。操作は実行前に保存される。
キューへの保存後に失敗した場合は、goal_operation_id から同じタスクを復元する。Git更新後に保存が失敗した場合は、保存されたSHAが取り込み先に含まれるかを照合して、初回の操作結果を補う。新しくGitを変更する場合は、既存の所属・SHA・チェックアウトの検査が行われる。再試行で通知の保存件数を増やしたり、Slackへ再送したりはしない。保存後、送信前に停止した場合のSlack通知は保証されない。

古いゴールのIDがないイベント・sessions・decisionsは、読み込み時に新しい形式へそろえられる。読み取りだけではファイルを変更せず、次の更新で新しい形式だけを保存する。古いセッションは再開しない。質問の recipient は human / director、回答の source は tui / slack / director。directorへの転送とSlackからの回答受信は未実装。
delegation_completion は requestId・result・evidenceRefs を表す。判断の actor は manager / human / adjudicator で、判定役の operation は許可・停止・人に判断を仰ぐことを表せる。依頼の実行と判定役の実行は未実装。
