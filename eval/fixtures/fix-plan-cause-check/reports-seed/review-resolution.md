# レビュー裁定

## 結果: 修正対象あり

## actionable family

| family | finding ID | 修正権限の根拠 | 根拠 | 問題 → 根本原因 | 受入条件 | 修正境界 |
|---|---|---|---|---|---|---|
| `F-MOCK-E2E-GATE` | `FINAL-E2E-001` | 必須の mock E2E 全体ゲートが成功していない | 全体実行1回目では `provider-override.e2e.ts` の子プロセス終了コードが期待と不一致。2回目では全テスト成功後に bare `Timeout calling "onTaskUpdate"`。該当する8テストはそれぞれ単独実行で1回成功。現行runnerは4 shardを `Promise.all` で起動する | mock E2E全体ゲートが終了コード1 → 単独では成功するテストを4 shard同時起動する → shard間の実行資源競合 | 現在の差分で `npm run test:e2e:mock` が全suiteを実行して終了コード0になる | E2E runnerまたは再現した直接原因に対する最小変更と全体ゲート再実行。timeout延長、skip、個別成功による代替、無関係な製品契約変更は除外 |
