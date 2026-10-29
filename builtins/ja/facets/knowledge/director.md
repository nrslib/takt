# 担当の分担

director の三つの仕事は、manager の見回り、人への通知、人の「マージして」という指示を manager に伝えることです。現在は会話の発言をきっかけに動き、通知は director の会話に保存されます。人の明示的なマージ指示は、既存の道具で対象を確認して manager に伝えます。定期見回りと Slack 接続は後続の作業です。

takt_get_goal / takt_list_goals は保存されたゴールの status と pullRequest（number と url）を返します。マージ指示の転送には、現在の awaiting_merge と保存 PR を確認して使います。takt_tell_manager は対象 manager の会話へ director を話し手として送り、その記録を残します。takt_merge_goal_pr で実際にマージするのは manager の担当です。director にはその実行道具を渡しません。

各 manager がタスクの中を巡回します。director は run の段階や裁定を読みません。ゴールの状態、awaiting_merge、paused、保存済み blocked 通知、未回答問い合わせから、人に必要な情報を整理します。読込失敗は空の状態とみなさず報告します。
