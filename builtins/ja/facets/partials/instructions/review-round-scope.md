{review_scope}

上に提示された変更対象一覧に載っているものは、エンジンが base 分岐点から算出した変更対象の正です。自前の `git diff` を、一覧に載っているものを対象から外す根拠には使わないでください。自前の diff が空でも、一覧にあるファイルは変更対象として読んでください（実装が run 開始前にコミット済みの場合、その変更は作業ツリーの diff に現れません）。

スコープ欄が範囲の限定・不足・算出不能を述べている場合は、その記述に従って不足分を自分で補ってください（省略件数、base をどう決めたか、変更を検出しなかった、Git リポジトリではない、算出していない、などの記述がこれにあたります）。この場合に限り、自前のコマンド実行で対象を追加します。

レビューの走査範囲は、Finding Contract がある場合は台帳サマリの `reviewMode` に従ってください。ない場合は、呼び出し元から継承したレビュー区分 `{var:review_mode}` に従ってください。レビュー区分が `unspecified` の場合に限り、直接実行される reviewer step の `{step_iteration}` が `1` なら `initial`、`2` 以上なら `follow_up` としてください。

`initial` では提示された変更対象一覧を全件確認し、変更された contract family ごとに、定義、生成、正規化・検証、全 consumer、retry・fallback・parallel、永続化・復元、terminal・API 出力まで、定義・参照と実在する呼び出し・データフローを縦に追って同じ回で閉じてください。変更された不変条件、正本、根本原因を共有する経路だけを同じ family とし、隣接する別契約の一般探索や水平な品質改善へ広げないでください。

`follow_up` では修正対象が解消へ向けて単調に減るよう、open findings の解消確認を中心に、その修正箇所と直接影響する経路を確認してください。新しい finding を出せるのは、`accepted_family_unvisited_consumer`（採用済み family に属する未確認 consumer）、`remediation_regression`（修正が導入した退行）、`direct_acceptance_criterion_violation`（受入条件の直接違反）のいずれかに限ります。新しい finding にはこの authorization basis と初回に含まれなかった理由を記録してください。未確認 consumer は水平な新規 family を開かず採用済み family へ紐付け、初回から存在したことだけを理由に持ち越し扱いにせず、未変更領域の一般探索は再開しないでください。

継続レビューで blocking finding がなく APPROVE を出す場合は、その直前に提示された変更対象一覧を回帰確認してください。新しい一般探索は行わず、open findings の修正が変更契約を壊していないことと、採用済み family に未確認 consumer が残っていないことを確認します。継続レビューでは、確認した範囲と根拠を、出力契約が定める既存の検証・根拠欄へ記録してください。
