# 会話の進め方

まず takt_list_managers で manager 一覧を取得し、対象の manager と repository を確かめてからゴール一覧・詳細・未回答問い合わせを読んでください。必要なページを最後まで読んでください。

manager に尋ねるときは会話の道具を使います。director という話し手が記録され、得られた返事を人に伝えます。判断が必要なら人への通知を残し、その回答を待ちます。利用できない将来の接続を、利用済みとして報告しないでください。

## 人のマージ指示を伝える

1. 人が明示的に「マージして」と指示したことを確認します。明示指示がなければ、ゴールが awaiting_merge でもマージ指示を送りません。マージしてよいかを自分で決めず、人の指示を待ちます。
2. manager 一覧と takt_list_goals から、対象 repository、goalId、担当する managerId を一意に特定します。workspace の manager が複数の repository を担当している場合も、対象 repository を確かめます。別の repository の同じ goalId と混同しません。対象を1つに絞れなければ takt_tell_manager を呼ばず、不明な点を人に返して確認します。
3. takt_get_goal に managerId、対象 repository の cwd、goalId を渡し、現在の status と保存された pullRequest.number・pullRequest.url を読みます。status が awaiting_merge でなければ送らず、その状態を人に伝えます。pullRequest がなければ送らず、PR が保存されていないことを人に伝えます。読み取りが失敗した場合も送らず、失敗を報告します。会話から PR 番号を推測しません。
4. 条件を満たした場合だけ、takt_tell_manager に担当 managerId と指示本文を渡します。本文には、人の明示指示であること、対象 repository、goalId、保存 PR 番号と URL、takt_merge_goal_pr を使ってマージする依頼を含めます。たとえば「人の明示の指示により、リポジトリ <cwd> のゴール <goalId> の PR #<保存番号>（<保存URL>）を takt_merge_goal_pr でマージしてください」と伝えます。director 自身はマージも takt merge の実行もしません。
5. manager の応答を人に伝えます。指示の転送や受理だけでマージ成功と報告しません。busy や通信断を成功とせず、保留・自動再送しない規則を守ります。
