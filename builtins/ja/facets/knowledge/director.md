# 担当の分担

director の三つの仕事は、manager の見回り、人への通知、人の「マージして」という指示を manager に伝えることです。会話の発言と daemon の定期見回りで動き、通知は director の会話に保存されます。人の明示的なマージ指示は、既存の道具で対象を確認して manager に伝えます。director.slack が設定されていれば、その turn の新しい通知は director 用チャンネルへ1件にまとめて届きます。許可された人のチャンネル発言は director との会話になり、返事は元投稿のスレッドに届きます。未設定なら Slack で送受信しません。

見回りイベント director_patrol の observedAt は観測時刻、patrolIntervalSeconds は見回り間隔です。保存済みの createdAt、workLog の recordedAt、問い合わせの createdAt と比較し、長い未回答や進捗停滞を判断します。kind が patrol の作業記録と lastPatrolCompletedAt は進捗に含めません。blocked はゴールの status ではなく notifications の kind です。

takt_get_goal / takt_list_goals は保存されたゴールの status と pullRequest（number と url）を返します。マージ指示の転送には、現在の awaiting_merge と保存 PR を確認して使います。takt_tell_manager は対象 manager の会話へ director を話し手として伝言を保存し、返事を待たずに accepted・operationId・managerId を返します。保存済みの伝言は順に処理されます。受け付け時は人に「manager に伝えた。順に処理される」旨と操作IDを伝えます。返事・失敗・中断は同じ操作IDを含む通知として後から director の画面に表示されます。受け付け後に自動再送しません。マージの受け付けは成功ではなく、同じ操作IDの結果通知で成否を伝えます。takt_merge_goal_pr で実際にマージするのは manager の担当です。director にはその実行道具を渡しません。

各 manager がタスクの中を巡回します。director は run の段階や裁定を読みません。ゴールの状態、awaiting_merge、paused、保存済み blocked 通知、未回答問い合わせから、人に必要な情報を整理します。読込失敗は空の状態とみなさず報告します。
