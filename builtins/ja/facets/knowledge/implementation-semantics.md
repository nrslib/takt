# 実装意味論

テストが全部通っていても残る、実装のミクロな設計の癖を判定するための知識。対象は、データ構造の選択、状態の正規化、命名と意味の整合、境界での fail-fast。いずれも「動くかどうか」ではなく「意味が正しいか」の問題であり、テストでは原理的に検出しにくい。

## テスト期待値は元要件に従う

期待する振る舞いは現行実装ではなく、元要件と仕様から導く。現行の振る舞いを再現するだけのテストは、欠陥を固定し得る。


## データ構造の意味選択

コレクションや辞書は、格納するデータの意味に合った型を選ぶ。とくに、外部由来の文字列をキーとする辞書をプレーンオブジェクトで実装すると、プロトタイプ経由の継承プロパティが混入する。


遮断済みの `Record` を「`Map` にすべき」と指摘してはならない。`Object.hasOwn` / `Object.create(null)` による遮断は完全な対策であり、その上での `Record` 継続使用は設計不備ではない。とくに公開契約（変更禁止の型定義）が `Record` を定めている場合、内部でできる対策は遮断がすべてである。指摘してよいのは「遮断されていないアクセスが残っている箇所」だけで、その場合も場所を特定して示す。

```typescript
// 避ける例: "toString" という ID を渡すと、未登録なのに存在扱いになる
const reservations: Record<string, Reservation> = {};
if (reservationId in reservations) { /* 継承プロパティにもマッチする */ }

// 例: Map は継承プロパティの混入がない
const reservations = new Map<string, Reservation>();
if (reservations.has(reservationId)) { /* 登録したキーだけにマッチする */ }
```

## 導出値の単一情報源

ある値から計算で導出できる値を、別の変数として並行管理しない。二重に持った瞬間から、両者がズレる可能性と、ズレたときにどちらが正かという問いが生まれる。


```typescript
// 避ける例: 履歴の長さから導出できる version を別管理。ズレたら在庫計算が狂う
class EventStore {
  private version = 0;
  append(e: Event) { this.events.push(e); this.version++; }
}

// 例: 導出元だけを持ち、version は導出する
class EventStore {
  get version() { return this.events.length; }
  append(e: Event) { this.events.push(e); }
}
```

## 命名と意味の整合

名前は、その変数に実際に入る値の意味を表す。名前と中身が乖離した変数は、読み手に誤った前提を植え付け、次の変更でバグを生む。


```typescript
// 避ける例: qtyShip という名前だが、実際に入るのは予約ID
function applyShipped(qtyShip: string) { delete this.reservations[qtyShip]; }

// 例: 名前が中身の意味と一致している
function applyShipped(reservationId: string) { delete this.reservations[reservationId]; }
```

## 境界での fail-fast

ありえない状態や契約違反の入力は、黙って無視せず、境界で即座に失敗させる。サイレントに握りつぶすと、不整合が下流に伝播してから発覚し、原因の特定が難しくなる。


```typescript
// 避ける例: 作成前の商品へのイベントを黙って無視。イベントログの破損が検出できない
apply(event: StockEvent) {
  const product = this.products[event.productId];
  if (!product) return;
}

// 例: ありえない状態は即座に失敗させ、破損を早期に検出する
apply(event: StockEvent) {
  const product = this.products.get(event.productId);
  if (!product) throw new Error(`event for unknown product: ${event.productId}`);
}
```

## 内部状態の参照漏れ

ストアや読み取りモデルが内部状態への参照をそのまま返すと、呼び出し側の変更が保存済みデータに波及する。返す側で防衛的コピーを取るか、不変な形で返す。


## 識別子名前空間の衝突

生成する ID、token、key は、既存入力の名前空間と下流の構文の両方で衝突しない必要がある。一意な採番元があることと、識別子が衝突しないことは別条件である。
