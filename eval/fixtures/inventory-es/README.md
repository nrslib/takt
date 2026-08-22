# inventory-es

イベントソーシングで在庫管理ドメインを実装するライブラリ。

## 実装するもの

`src/types.ts` の公開契約（変更禁止）に基づき、次の公開 API を実装して
`src/index.ts` から re-export する。テストは `src/index.ts` と `src/types.ts` にのみ依存する。

| API | 種別 | 責務 |
|-----|------|------|
| `initialState` | 定数 | 未作成の商品を表す初期状態 |
| `evolve(state, event)` | 純粋関数 | イベントを状態に適用する。throw しない。引数を変更しない |
| `decide(state, command)` | 純粋関数 | コマンドから新イベントを導出する。不変条件違反は `DomainError` |
| `InMemoryEventStore` | クラス | `EventStore` ポートの実装。楽観的並行性制御付き |
| `CommandHandler` | クラス | load → replay → decide → append のオーケストレーション |
| `StockProjection` | クラス | イベントから在庫の読み取りモデルを構築する |

## ドメインルール

- `CreateProduct`: 既存の商品は再作成不可。名前は trim 後に空でないこと
- `ReceiveStock`: 商品が存在すること。数量は正の整数
- `ReserveStock`: available（`onHand − 予約数量合計`）以内であること。`reservationId` は未使用であること。数量は正の整数
- `ReleaseReservation`: 予約が存在すること。在庫は変わらず予約だけ解放される
- `ShipStock`: 予約が存在すること。予約数量ぶん `onHand` が減り、予約は消える

## イベントストアのセマンティクス

- `version` はストリームに保存済みのイベント数。空ストリームの `load` は `{ events: [], version: 0 }`
- `append(streamId, events, expectedVersion)` は `expectedVersion` が現在の version と一致しないとき `ConcurrencyError` を throw し、何も保存しない
- `load` が返す配列を変更しても、ストア内部は影響を受けないこと

## プロジェクションのセマンティクス

- `getStock(productId)` は `{ onHand, reserved, available }`。未知の商品は `undefined`
- `StockShipped` では予約数量ぶん `onHand` と `reserved` が減る（イベント自体は数量を持たないことに注意）
- `lowStock(threshold)` は `available < threshold` の productId を昇順で返す

## アーキテクチャ要件

モジュール分割はあなたの設計判断に委ねる。ただし次を守ること。

- ドメインロジック（`decide` / `evolve`）は純粋に保ち、ストアやプロジェクションに依存しないこと
- `CommandHandler` は `EventStore` ポート（インターフェース）にのみ依存し、具象実装に依存しないこと
- プロジェクションは書き込みモデル（集約の状態）を参照せず、イベントのみから構築すること
- `src/types.ts` は変更禁止。`src/index.ts` の公開 API シグネチャも変更禁止

## 開発

```bash
npm test          # vitest（tests/ 配下、変更禁止）
npm run typecheck # tsc --noEmit
```
