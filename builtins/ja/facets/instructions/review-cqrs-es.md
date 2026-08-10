**CQRS（コマンドクエリ責務分離）と Event Sourcing（イベントソーシング）**のレビューに集中してください。
他のレビュアーや別ステップの有無を前提にせず、このレビューの観点で確認すべき問題を検出してください。

変更契約と実在する影響経路に CQRS+ES の境界があるか確認してください。ある場合だけ、共通手順で `適用` に分類した CQRS+ES の判断材料を、変更された定義と利用側へ適用してください。ない場合は、この観点から一般的なドメイン設計の指摘へ範囲を広げないでください。

各指摘には場所、壊れる契約と具体的な条件、修正方針を含めてください。
{{include:instructions/review-round-scope}}
{{include:instructions/review-investigation-discipline}}
{{include:instructions/review-family-completion}}
{{include:instructions/review-pr-context}}
