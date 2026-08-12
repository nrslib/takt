open findings の解消確認を中心に、修正箇所と直接影響する経路を確認してください。accepted family の共通所有者、重複実装、未確認・未移行 consumer を見つける bounded horizontal comparison は行いますが、accepted family の外へ一般探索や新規 family の探索を広げてはなりません。

{{include:instructions/review-family-authority-boundary}}

新しい finding を出せるのは次の Authorization Basis のいずれかに限ります。

- `accepted_family_unvisited_consumer`: 採用済み family に属する未確認 consumer
- `remediation_regression`: 修正が導入した退行
- `direct_acceptance_criterion_violation`: 受入条件の直接違反
- `required_consumer_migration`: 変更済み契約を成立させる必須 consumer migration

新しい finding には Authorization Basis と Reason Absent（初回レビューに含まれなかった理由）を必ず記録してください。未確認 consumer は active accepted family へ紐付け、初回から存在したことだけを理由に持ち越し扱いにせず、未変更領域の一般探索を再開しないでください。通常経路と isolated failure path が同じ根本原因・正本・要求契約を共有する場合は同じ family として扱い、別 family を開かないでください。比較中に見つけた隣接・別 family の問題は new finding や fix scope へ追加しないでください。

blocking finding がなく APPROVE を出す直前に、提示された変更対象一覧を回帰確認してください。新しい一般探索は行わず、open findings の修正が変更契約を壊していないことと、accepted family に未確認 consumer が残っていないことを確認し、確認範囲と根拠を出力契約の既存の検証・根拠欄へ記録してください。
