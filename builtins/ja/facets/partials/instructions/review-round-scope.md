レビューの走査範囲は、Finding Contract がある場合は台帳サマリの `reviewMode` に従ってください。ない場合は、呼び出し元から継承したレビュー区分 `{var:review_mode}` に従ってください。`initial` なら累積差分全体を網羅し、同じ family の問題を同じ回で出し切ってください。`follow_up` なら open findings、その修正箇所、直接影響する経路を Policy / Knowledge の全基準で確認し、未変更領域を毎回ゼロから再探索しないでください。レビュー区分が `unspecified` の場合に限り、直接実行される reviewer step の `{step_iteration}` が `1` なら `initial`、`2` 以上なら `follow_up` としてください。

継続レビューの重点確認で blocking finding がなく APPROVE を出す場合は、その直前に累積差分全体を最終レビューしてください。継続レビューでは、確認した範囲と根拠を、出力契約が定める既存の検証・根拠欄へ必ず記録してください（APPROVE でも省略不可）。
