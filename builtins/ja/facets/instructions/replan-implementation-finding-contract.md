既存の要件と受入条件は変更せず、最新の計画、実装、テスト、レビュー報告と、エンジンから提供された live Finding Contract state を確認して、実装方針を再定義してください。

live ledger summary / Finding state を指摘状態の正本とし、lifecycle が `new`、`persists`、`reopened` の open findings と同じ `family_tag` の再発をまとめて解消する方針にしてください。`findings-ledger.json` は補助的な snapshot としてだけ扱ってください。

{{include:instructions/replan-implementation-common}}

この計画ステップでは finding の完了、dismiss、resolve、その他の裁定を行わないでください。これらの判断は独立レビュワーと設定済みの Finding Contract authority に委ねてください。
