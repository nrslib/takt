# Review resolution

## 修正対象

- `PATH-001`: `buildExecutionPlan(input, source)` は、呼び出し側が `selection`、`workflow`、`monitor` のうち変更するsectionだけを `source` で上書きし、指定しないsectionには既定の `definition` を使う契約である。現在の `loadDefinition(source)` は渡された `source` 全体をそのまま返すため、1つのsectionだけを上書きすると他のsectionが失われ、無関係な結果の生成まで失敗する。既定値との合成を正本のloaderで行い、3つの独立した結果を同じ公開入口から保護する修正計画を作成する。

## 受入条件

- `selection` だけを上書きした場合、その `role` と `instruction` が選択結果へ反映され、既定のcycleとmonitor結果は維持される
- `workflow` だけを上書きした場合、その `entry` と `calls` に応じてcycle結果が変わり、既定のselectionとmonitor結果は維持される
- `monitor` だけを上書きした場合、その `limit` と `instruction` に応じてdecisionと展開済みinstructionが変わり、既定のselectionとcycle結果は維持される
- sectionを省略した完全な既定経路と、完全な `source` を渡す既存経路を壊さない

## 対象外

- 新しい設定項目や利用経路の追加
- 現在の実装から到達できない状態への対応
