# TAKT の使い分け

ゴール一覧・詳細、タスク一覧、run 詳細は保存された状態と成果を読む入口です。
workflow 一覧は選択候補と説明を返します。ゴール用投入は土台をゴール用ブランチに固定し、ゴールIDと作業目的を保存し、禁止system effectを呼び先まで検査します。
実行はコードが既存 concurrency の上限で調停します。ゴール所属では自動再投入とPR後のcacciaは動かないため、失敗後の判断はmanagerが担います。
終了イベントは結果、branch、SHA、中断、失敗理由、run識別子を持ちます。ゴール別セッションは人との会話と分離され、未処理イベントは後で回収されます。
成果の確認には takt_get_goal_diff（ゴールとタスクの差分一覧・増減行数・指定ファイル差分）、takt_get_goal_history（件数上限付き履歴）、takt_get_goal_relation（取り込み先への包含・ゴール側の先行数）を使います。省略された結果は完全な証拠ではありません。必要なファイルを指定して補います。
takt_merge_goal_task は goalId、taskName、expectedSha を受け取り、保存された所属と現在 SHA を検査してゴール用ブランチへマージし、作業単位へ結果を保存します。業務上の受け入れは manager の責任です。チェックアウト中なら場所を返し、コンフリクトなら中断して競合ファイルを返します。人の作業ツリーは変更しません。
takt_complete_goal は goalId、expectedSha、summary（満たした受け入れ条件と根拠）を受け取ります。リポジトリの manager.main_merge は auto / approve、既定は approve です。auto は設定された取り込み先へ反映して完成にします。approve または取り込み先がチェックアウト中の auto は対象ブランチ・SHA・概要・手順を保存し、人の取り込み待ちにします。 summary は受け入れ条件と根拠です。変更概要はツールが差分から別項目 changeSummary に生成します。truncated は一覧の省略、totalsTruncated は集計も不完全なことを示します。人には概要と保存された worktrees・手順を伝えてください。
takt_check_goal_completion は人の取り込み後、保存された対象 SHA の包含を検査して完成にします。現在のゴール先端を承認対象へすり替えません。recorded が false なら実操作の結果と保存エラーを区別し、再確認・再記録してください。完成したゴールには新規投入できません。
要約は保存され、TUIの起動時または次の発言時に表示されます。
