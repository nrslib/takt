# 実装意味論

テストが全部通っていても残る、実装のミクロな設計の癖を判定するための知識。対象は、データ構造の選択、状態の正規化、命名と意味の整合、境界での fail-fast。いずれも「動くかどうか」ではなく「意味が正しいか」の問題であり、テストでは原理的に検出しにくい。

## データ構造の意味選択

コレクションや辞書は、格納するデータの意味に合った型を選ぶ。とくに、外部由来の文字列をキーとする辞書をプレーンオブジェクトで実装すると、プロトタイプ経由の継承プロパティが混入する。

| 基準 | 判定 |
|------|------|
| 外部入力（ID、ユーザー入力）をキーとする辞書が `Record` / プレーンオブジェクトで実装され、`in` 演算子や `obj[key]` で存在判定している | REJECT |
| `__proto__`、`constructor`、`toString` のようなキーで挙動が変わる余地がある | REJECT |
| 動的キーの辞書に `Map` を使う、または `Object.create(null)` / `Object.hasOwn` で継承経路を遮断している | OK |
| キーが固定の有限集合（設定オブジェクト等）でプレーンオブジェクトを使う | OK |

```typescript
// REJECT - "toString" という ID を渡すと、未登録なのに存在扱いになる
const reservations: Record<string, Reservation> = {};
if (reservationId in reservations) { /* 継承プロパティにもマッチする */ }

// OK - Map は継承プロパティの混入がない
const reservations = new Map<string, Reservation>();
if (reservations.has(reservationId)) { /* 登録したキーだけにマッチする */ }
```

## 導出値の単一情報源

ある値から計算で導出できる値を、別の変数として並行管理しない。二重に持った瞬間から、両者がズレる可能性と、ズレたときにどちらが正かという問いが生まれる。

| 基準 | 判定 |
|------|------|
| 導出できる値（合計、件数、バージョン）を別変数でも加算・減算して管理している | REJECT |
| 明細と集計値を並行更新しており、不正な入力で乖離し得る | REJECT |
| 導出値は使う場所で計算する、または導出元だけを更新して集計は関数で得る | OK |
| 性能上の理由でキャッシュする場合、更新経路が1本に集約され、乖離時の検出がある | OK |

```typescript
// REJECT - 履歴の長さから導出できる version を別管理。ズレたら在庫計算が狂う
class EventStore {
  private version = 0;
  append(e: Event) { this.events.push(e); this.version++; }
}

// OK - 導出元だけを持ち、version は導出する
class EventStore {
  get version() { return this.events.length; }
  append(e: Event) { this.events.push(e); }
}
```

## 命名と意味の整合

名前は、その変数に実際に入る値の意味を表す。名前と中身が乖離した変数は、読み手に誤った前提を植え付け、次の変更でバグを生む。

| 基準 | 判定 |
|------|------|
| 変数名・引数名が示す意味と、実際に格納される値の意味が異なる（例: `qty` という名前に ID が入る） | REJECT |
| 型は合っているが、単位・座標系・正規化状態が名前から読み取れず、混用されている | REJECT |
| 名前から中身の意味・単位・状態が一意に読み取れる | OK |

```typescript
// REJECT - qtyShip という名前だが、実際に入るのは予約ID
function applyShipped(qtyShip: string) { delete this.reservations[qtyShip]; }

// OK - 名前が中身の意味と一致している
function applyShipped(reservationId: string) { delete this.reservations[reservationId]; }
```

## 境界での fail-fast

ありえない状態や契約違反の入力は、黙って無視せず、境界で即座に失敗させる。サイレントに握りつぶすと、不整合が下流に伝播してから発覚し、原因の特定が難しくなる。

| 基準 | 判定 |
|------|------|
| 前提が壊れた入力（存在しない対象へのイベント、順序違反）を無言でスキップしている | REJECT |
| 例外を握りつぶして正常値を返し、呼び出し側が失敗を検知できない | REJECT |
| 契約違反は明示的なエラー・例外・Result 型で即座に表面化させている | OK |
| 仕様として無視する場合、その判断がコメントまたは仕様書で明文化されている | OK |

```typescript
// REJECT - 作成前の商品へのイベントを黙って無視。イベントログの破損が検出できない
apply(event: StockEvent) {
  const product = this.products[event.productId];
  if (!product) return;
}

// OK - ありえない状態は即座に失敗させ、破損を早期に検出する
apply(event: StockEvent) {
  const product = this.products.get(event.productId);
  if (!product) throw new Error(`event for unknown product: ${event.productId}`);
}
```

## 内部状態の参照漏れ

ストアや読み取りモデルが内部状態への参照をそのまま返すと、呼び出し側の変更が保存済みデータに波及する。返す側で防衛的コピーを取るか、不変な形で返す。

| 基準 | 判定 |
|------|------|
| コレクションのコピーは返すが、格納されたオブジェクト自体は共有されている（浅いコピー止まり） | REJECT |
| 取得した参照を変更すると、保存済みの状態が書き換わる | REJECT |
| 防衛的コピー、凍結、読み取り専用ビューのいずれかで内部状態が保護されている | OK |
