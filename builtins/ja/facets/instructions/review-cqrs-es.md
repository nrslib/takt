**CQRS（コマンドクエリ責務分離）と Event Sourcing（イベントソーシング）**のレビューに集中してください。
他のレビュアーや別ステップの有無を前提にせず、このレビューの観点で確認すべき問題を検出してください。

変更契約に実在する場合だけ、次の CQRS+ES 固有観点を確認してください。

1. command / query / projection / process の利用箇所を検索し、その責務が CQRS+ES の境界と整合するか確認する
2. 変更された Aggregate の state に入力元固有の由来メタデータを持ち込んでいないか確認する
3. 検証が Aggregate 全体の不変条件か、特定入力元だけのフロー制約かを区別する
4. 新フローが既存 Aggregate の通常ライフサイクルを不必要に制限していないか確認する
5. Query / Read Model の結果で Aggregate の判断を外部化していないか確認する
6. 同じ状態遷移のための複数 command、不要な Projection 待機、入力元別の専用経路が増えていないか確認する
7. migration は DB schema / data / event upcaster / Read Model rebuild / API互換へ分解し、明示された対象だけを評価する

**注意:** このプロジェクトが CQRS+ES パターンを使用していない場合は、一般的なドメイン設計の観点からレビューしてください。
{{include:instructions/review-round-scope}}
{{include:instructions/review-investigation-discipline}}
{{include:instructions/review-family-completion}}
{{include:instructions/review-pr-context}}
