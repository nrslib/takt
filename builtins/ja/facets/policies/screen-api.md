# 画面専用APIポリシー

画面または領域が表示・操作に必要とするデータを、APIの応答項目、データ量、サーバー側の制約、結果の整合性から設計・判定する。画面のコンポーネント構造や通信開始のタイミングではなく、サーバーとのデータ契約を対象にする。

## 原則

| 原則 | 基準 |
|------|------|
| 応答項目 | 画面の表示と操作が必要とする識別子、状態、関連データ、集計値を応答契約に含める |
| データ量 | 結果件数、上限、ページング、cursorの条件をサーバーが検証し、実際のデータ量に合わせる |
| サーバーの正本 | 認可、業務上の判定、永続化前提の状態遷移はサーバーが現在のデータから決める |
| 集計 | 件数や合計をサーバーで計算するか、取得済みの有限データを扱うかを量と判定の性質から決める |
| 結果の整合性 | 更新との競合、ページの連続性、重複・欠落、古い応答の扱いをAPI契約に含める |
| エラー契約 | 認証・認可、入力不備、競合、未検出、サーバー障害を区別できる応答にする |

## 応答項目とエンドポイント

画面の用途に合わせて応答の形を設計する。画面名とエンドポイント名を一対一にすることではなく、実際に必要な項目と操作の契約を満たすことを確認する。

| 基準 | 判定 |
|------|------|
| 表示または操作に必要な識別子、状態、関連項目が応答にないまま、別の項目を意味の異なる値として流用する | REJECT |
| 一覧応答が、件数・関連項目・状態などその画面が必要とする項目を契約どおり含む | OK |
| 一覧と詳細で必要な項目、データ量、認可範囲が異なるため、応答契約を分ける | OK |
| 詳細に必要な項目が不足し、全件一覧を取得してクライアントで補う | REJECT。項目または取得境界を設計する |
| 関連データを大量の個別リクエストで取得し、実データ量や応答時間が許容範囲を超える | REJECT |
| 一覧応答を詳細でも使い、項目・認可・件数がその詳細の契約を満たす | OK |

```typescript
// NG - 一覧のsummaryを詳細のdescriptionとして流用し、必要項目を埋める
async function loadDetail(id: string) {
  const list = await fetchList({ date })
  const item = list.items.find(item => item.id === id)
  return item && { ...item, description: item.summary }
}

// OK - 詳細契約が必要な項目と認可範囲を返す
async function loadDetail(id: string) {
  return await fetchDetail(id)
}
```

一覧と詳細を分けるか、同じ応答を使うかは、必要項目、結果件数、認可、更新頻度、実際のデータ量で決める。名前だけで専用性を判断しない。

## データ量とページング

小さく上限が明確な一覧は一回で返せる。大きくなり得る結果はサーバーで上限を検証し、ページング方式と順序の契約を持つ。クライアントがページサイズやfilterを指定するAPIも、サーバーが許容範囲と上限を検証し、応答の契約を維持するなら利用できる。

| 基準 | 判定 |
|------|------|
| 固定された小さい集合を全件返し、件数上限が仕様と実データで説明できる | OK |
| `limit`、page size、sort、filterをクライアントが指定し、サーバーが型・権限・上限を検証する | OK |
| クライアントの指定をサーバーが無制限に受け、結果量や応答時間の上限がない | REJECT |
| 大きくなり得る一覧を上限なしで全件返す | REJECT |
| cursorにsort、filter、テナント、スナップショットなど結果を決める条件が含まれず、ページが重複・欠落する | REJECT |
| サーバーが既定値と最大値を持ち、クライアントの指定をその範囲へ収める | OK |

```typescript
// OK - リクエスト値を受けるが、サーバー側で最大値を適用する
const result = await fetchList({ date, limit: 20, nextId })

// サーバー側の例
const requestedSize = request.limit ?? DEFAULT_PAGE_SIZE
if (!Number.isInteger(requestedSize) || requestedSize < 1) {
  throw new RangeError('limit must be a positive integer')
}
const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE)
return listOrders({ date: request.date, nextId: request.nextId, pageSize })
```

`limit`やページングを指定すること自体ではなく、実際の最大データ量、権限による範囲、応答時間、cursorの安定性を判定する。

## 集計と業務判定

既に取得した有限の表示データを画面上で並べ替えたり集計したりすることと、サーバーが正本として判定すべき値をクライアントで確定することを分ける。データ量が大きい、最新性が必要、認可や業務状態に依存する場合はサーバーの集計・判定応答を設計する。

| 基準 | 判定 |
|------|------|
| 上限のある小さな一覧を表示用に合計し、応答の項目だけから導出する | OK |
| 大量または上限不明の全件を取得して件数・合計・判定を行う | REJECT |
| 在庫、権限、生成可否、業務上の状態遷移をクライアントだけで確定する | REJECT |
| サーバーが現在のデータから集計値や判定結果を計算し、根拠となる状態とともに返す | OK |
| 集計結果と明細の対象範囲・更新時点が異なり、画面がどの結果を表示したか追えない | REJECT |

## サーバー認可と制約

クライアントが表示したフラグ、件数、価格、在庫、権限を、サーバーが受け取った最終判定として扱わない。サーバーは認証された主体、対象リソース、テナント、現在状態、操作権限を検証し、拒否理由を契約された応答で返す。

| 基準 | 判定 |
|------|------|
| リクエストの `canApprove` やクライアント計算値だけで永続化・権限変更を許可する | REJECT |
| サーバーが対象と主体を再取得し、現在の認可と状態を検証してから操作する | OK |
| テナント・所有者・対象IDの条件がサーバー側の検索と更新の両方へ適用される | OK |
| 権限不足、対象なし、状態競合、入力不備を同じ成功応答として返す | REJECT |

```typescript
// NG - クライアントから届いた判定を信頼する
function approve(request: { orderId: string; canApprove: boolean }) {
  if (request.canApprove) return persistApproval(request.orderId)
}

// OK - サーバーが現在の権限と状態を検証する
async function approve(orderId: string, actor: Actor) {
  const order = await findOrderForActor(orderId, actor)
  if (!order) return { status: 'not-found' as const }
  if (!order.canBeApproved) return { status: 'conflict' as const }
  return persistApproval(order.id, actor.id)
}
```

## 結果の整合性

更新と取得が並行する場合は、どの時点の結果を返すか、古い書き込みをどう拒否するか、ページをどの順序で連結するかをサーバー契約へ含める。ETag、version、idempotency key、snapshot cursorなどは、実際の競合条件に対応するときに選ぶ。

| 基準 | 判定 |
|------|------|
| 更新対象のversionやETagを検証し、古い更新を成功扱いにしない | OK |
| 同じ操作の再送が重複作成を起こすのに、idempotencyや重複判定がない | REJECT |
| cursorの順序・filter・snapshotがページ間で維持される | OK |
| 成功応答と保存結果の関係、失敗時の再試行条件がAPIから追える | OK |

フロントエンドの表示やリクエスト開始の判断はfrontendポリシーで扱う。ここでは、APIが必要なデータを十分な項目と量で返し、サーバーが認可・業務判定・結果の整合性を保証できるかを確認する。
