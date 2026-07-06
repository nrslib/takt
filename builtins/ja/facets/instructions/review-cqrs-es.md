**CQRS（コマンドクエリ責務分離）と Event Sourcing（イベントソーシング）**のレビューに集中してください。
他のレビュアーや別ステップの有無を前提にせず、このレビューの観点で確認すべき問題を検出してください。

手順:
1. Knowledge と Policy の Source Path を Read ツールで開き、全文を取得する
2. それぞれの `##` セクションをすべて列挙する（取捨選択しない）
3. 列挙した各セクションの判定基準を変更差分と照合し、該当する問題を検出する
4. `sendAndWait` / `commandGateway.send` / `QueryGateway` / `QueryBus` / `QueryHandler` / `ReadService` / `processStore` / `operationProcess` / `completeStep` / `materialStore` / `waitForProjection` / `delayedExecutor` / `subscriptionQuery` / `CompletableFuture` を検索し、CQRS+ES の責務として必要か確認する
5. 変更された Aggregate について、`source` / `input` / `origin` / `channel` / `type` / `kind` などの由来メタデータが state に復元されていないか確認する
6. 由来メタデータが `if` / `require` に使われている場合、その検証が Aggregate 全体の不変条件か、特定入力元だけのフロー制約かを判定する
7. 既存 Aggregate に新フローを統合する変更では、既存の通常ライフサイクルで許可されていた状態を新フロー都合で禁止していないか確認する
8. Query / Read Model の結果で同一 Aggregate への command 種別を投げ分けていないか確認し、Aggregate に寄せられる判断は Aggregate に寄せる
9. Application Service が同じ状態遷移のために複数 command を順番に送っていないか確認し、確定済みイベントの EventHandler に分離できる場合は指摘する
10. Projection 待機は同期 API 契約がある場合だけか確認し、不要なら即時応答や画面側の保持・ポーリングへ寄せる
11. migration が登場する場合、DB schema / data / event upcaster / Read Model rebuild / API互換のどれかを分解し、指示なしの migration 追加を指摘する
12. 既存 Aggregate の通常ライフサイクルで済む処理を、入力元別の専用 command / wrapper / service / deletion path にしていないか確認する

**注意:** このプロジェクトが CQRS+ES パターンを使用していない場合は、一般的なドメイン設計の観点からレビューしてください。
