# TAKT の使い分け

## workspace

workspace は `~/.takt/workspaces/<ID>/workspace.json` に ID、名前、担当リポジトリの一覧を保存します。1つのリポジトリは1つの workspace にだけ所属します。未所属のリポジトリから2つ目を担当に追加すると workspace が作られます。

担当変更の3ツールは manager ツールセット専用です。追加先は Git リポジトリであること、ほかの workspace に所属していないことを確認します。サブディレクトリやシンボリックリンクは Git のトップレベルに直します。削除は所属だけを外します。完成・中止以外のゴールがあるリポジトリは外せず、一時停止中も未完成に含みます。

manager MCP は毎回現在の担当を読み、`cwd` の Git リポジトリが担当一覧にあることを確認します。担当外の入れ子の別リポジトリもエラーになります。同じ担当リポジトリのサブディレクトリは、そのリポジトリを操作します。1つのゴールに属するタスクはそのリポジトリだけで実行します。

## 実行のしくみ

投入した作業は、実行開始時点のゴール用ブランチの先端をもとに始まる。
同時実行数の上限は system prompt の Concurrency limit の行に示される。このプロジェクトの run / watch に適用される上限で、空いている枠の数ではない。ほかのゴールと通常のタスクも同じ枠を使い、上限を超えて投入された作業は空きを待つ。
ゴールに所属するタスクには、自動再投入とPR作成後のcacciaは適用されないため、失敗後の判断は manager が行う。
終了すると、結果、branch、SHA、中断の有無、失敗理由、runの識別子を含むイベントが保存される。イベントのたびに新しいセッションで判断する。未処理のイベントは後で読み直して処理される。

## ツールと保存状態

ゴール一覧・詳細、タスク一覧、runの詳細から、保存された状態と成果を読める。
workflow 一覧は候補とその説明を返す。ゴールへの作業投入はゴールIDと作業目的を保存し、禁止されている system effect が含まれないか、呼び先も含めて検査する。
成果の確認には takt_get_goal_diff（ゴールとタスクの差分一覧、増減行数、指定ファイルの差分）、takt_get_goal_history（件数に上限がある履歴）、takt_get_goal_relation（成果が取り込み先に含まれるかどうかと、ゴール側で追加されたコミット数）を使う。結果の一部が省略されている場合は完全な根拠にならない。必要なファイルを指定して補える。

takt_requeue_goal_task は、failed または exceeded の同じゴールタスクを、保存された停止位置から再開するために pending へ戻す。retryNote で追加の指示を渡せる。takt_retry_goal_task は、failed の同じタスクを、修正した指示全文の task と任意の startStep でやり直す。開始位置を省略すると既存の再試行の既定値を使う。exceeded には使えない。failed のタスクの再開・やり直しで、保存された再開位置が使えないというエラーが返ったら、エラーに示された開始位置の一覧と run の詳細から再開する位置を選び、startStep に指定して呼び直す。exceeded のタスクの再開では startStep を指定できず、保存された停止位置がなければエラーになる。
takt_remove_goal_task は cwd・goalId・taskName・必須の reason と、任意の operationName を受け取り、不要になった待機中のタスクを取り消すか、やり直さない停止済みのタスクや取り込み済みの完了タスクを片付ける。実行中のタスクと、取り込んでいない完了タスクは対象外。待機中のタスクの取り消しは、進行中で一時停止していないゴールでだけ使える。

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

作業の記録には行動とその理由が保存され、operations には操作の pending / completed 状態と結果が保存される。投入・takt_requeue_goal_task・takt_retry_goal_task・takt_remove_goal_task・取り込み・完成・質問・通知・質問の取り下げ・完成確認は、イベントの操作名を使って再試行できる。操作は実行前に保存される。
キューへの保存後に失敗した場合は、goal_operation_id から同じタスクを復元する。Git更新後に保存が失敗した場合は、保存されたSHAが取り込み先に含まれるかを照合して、初回の操作結果を補う。新しくGitを変更する場合は、既存の所属・SHA・チェックアウトの検査が行われる。再試行で通知の保存件数を増やしたり、Slackへ再送したりはしない。保存後、送信前に停止した場合のSlack通知は保証されない。
タスクの削除も、イベントの中では operationName が必須。同じイベント・操作名・引数で再試行すると、保存された結果や途中からの回復の情報を使い、削除の履歴を重複させない。通常の会話での削除も記録されるが、呼び出すたびに別の操作になる。

ゴールの記憶は目的・範囲外・受け入れ条件・constraints・workLog・質問と回答です。登録は TUI の承認から直接行います。workLog は会話ターンでも記録でき、判断もこの短い作業の記録にまとめます。旧形式への変換と記憶のページ分けは行いません。質問の recipient は human、回答の source は tui / slack です。Slack からの回答受信は未実装です。
