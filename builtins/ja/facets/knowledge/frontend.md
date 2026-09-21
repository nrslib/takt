{extends:gui}

# フロントエンド知識

GUIの設計を、URL、ブラウザ、HTML、通信、アクセシビリティというWebの実行環境へ具体化する。画面の表示、操作、状態、通信の変更理由を分け、変更経路を追跡できる構造にする。

## URLと画面遷移

URLは画面への入口であり、ブラウザの履歴と外部リンクが参照する状態である。RouterはURLを画面のRootへ対応付け、画面側はパス・クエリ・履歴操作の契約を担当する。

```text
route('/orders/:orderId', OrderScreen)
```

画面を追加するときは、画面コンポーネントだけでなく、RouterからRootへ到達する経路、メニューやリンクなど利用者が操作する入口、戻る・進む・直接URLを開く場合の状態を確認する。ルートの記述場所やディレクトリはフレームワークの構成に合わせる。

| 条件 | 意味・選択肢 |
|------|-------------|
| URLが表す識別子や検索条件が画面状態に必要 | URLから画面へ明示的に渡す |
| 画面内だけで生きる表示状態 | URLへ押し出さず、画面の状態として保持する |
| 戻る・進むで戻るべき操作 | 履歴を更新する遷移として扱う |
| 直接URLを開いたときに存在しない対象や権限不足が起きる | 画面のエラー、空状態、リダイレクトを分けて表示する |

画面遷移の判断を個々の表示部品へ散らすと、リンク、キーボード操作、外部リンクで結果がずれる。遷移の判断は画面またはルーティングを担当する部分へ集め、表示部品は遷移意図を通知する。

## HTML操作とアクセシビリティ

ブラウザのHTML要素は、表示だけでなくキーボード操作、フォーカス、フォーム送信、支援技術への状態公開を提供する。見た目が似ている要素へ置き換える前に、利用者が受け取る操作契約を確認する。

ブラウザのDOMイベントはcaptureで祖先から対象へ、bubbleで対象から祖先へ伝わる。この伝播経路と、アプリケーションが操作意図を担当へ通知する経路は別に扱う。同じ操作を二つの経路で実行しないよう、既定動作と操作入口を確認する。

```tsx
// NG - クリック処理だけを持つ非対話要素
<div onClick={openDialog}>詳細</div>

// OK - ネイティブの操作契約を利用する
<button type="button" onClick={openDialog}>詳細</button>
```

新しい操作には、目的を表すaccessible name、適切な要素またはrole、disabled・expanded・selectedなどの状態、キーボードからの到達方法を用意する。フォームの入力にはlabelを関連付け、ダイアログを開閉する場合はフォーカスの移動と復帰を画面の操作経路に含める。

動的な文言は断片を連結するだけでなく、最終的な読み上げと意味を確認する。同じ一覧に複数ある編集・削除ボタンは、行の対象が名前またはプログラム上の関連付けから識別できるようにする。

| UIの状態 | 確認する契約 |
|----------|-------------|
| 選択、展開、チェック、無効 | 支援技術へ状態が伝わる要素・属性 |
| 通信中、成功、失敗 | 視覚だけでなく、必要なら読み上げる通知と操作可能な回復手段 |
| 空の一覧 | 「データがない」と「取得に失敗した」を区別する表示 |
| ダイアログやメニュー | 開く操作、フォーカス、閉じる操作、元の位置への復帰 |

## 通信状態と表示

通信をともなう画面は、未開始、読み込み中、成功、空、失敗、キャンセルを区別する。失敗時は原因の詳細をそのまま表示するのではなく、利用者が再試行や別の操作を選べる画面の状態へ変換する。

```tsx
// NG - 汎用の空状態が画面固有の通信手順を持つ
function EmptyState() {
  async function retry() {
    await fetch('/orders')
    window.location.reload()
  }

  return <button type="button" onClick={retry}>再読み込み</button>
}

// OK - 汎用表示は表示パラメータと意図の通知だけを受ける
function EmptyState({
  title,
  description,
  onRetry,
}: {
  title: string
  description: string
  onRetry?: () => void
}) {
  return (
    <section aria-live="polite">
      <h2>{title}</h2>
      <p>{description}</p>
      {onRetry && <button type="button" onClick={onRetry}>再試行</button>}
    </section>
  )
}
```

画面側の通信担当が `EmptyState` へ表示文言と再試行の入口を渡すと、通信方法を変えても汎用表示は変わらない。汎用表示へURL、APIクライアント、画面遷移を持ち込むと、再利用先ごとに通信手順を理解する必要が生じ、変更範囲が広がる。

## データ取得の境界

データ取得は、必要なデータとその更新を一貫して扱う画面または領域の担当で行う。画面全体の担当が取得して表示部品へ渡す構成、独立した領域が自分の入力から取得する構成、データ取得ライブラリが状態を管理する構成は、データの所有範囲と操作経路で選ぶ。

表示専用部品は、取得条件を組み立てたり、通信エラーの遷移を決めたりせず、表示値と操作入口を受ける。

```tsx
// NG - 汎用名の表示部品に画面固有の取得と表示判断が混在する
function DataTable({ accountId }: { accountId: string }) {
  const result = ordersForAccount(accountId)
  if (result.status === 'loading') return <Loading />
  if (result.status === 'error') return <ErrorPanel onRetry={result.retry} />
  if (result.orders.length === 0) return <EmptyState title="注文はありません" description="新しい注文を作成できます" />
  return <Table rows={result.orders} onRowSelect={result.select} />
}

// OK - 画面の担当が通信状態を判断し、表示部品へ値と操作入口を渡す
function OrderScreen({ result }: { result: OrderScreenResult }) {
  if (result.status === 'loading') return <Loading />
  if (result.status === 'error') return <ErrorPanel onRetry={result.retry} />
  if (result.orders.length === 0) {
    return <EmptyState title="注文はありません" description="新しい注文を作成できます" />
  }
  return <OrderTable rows={result.orders} onSelect={result.select} />
}

function OrderTable({ rows, onSelect }: { rows: Order[]; onSelect: (id: string) => void }) {
  return <Table rows={rows} onRowSelect={onSelect} />
}
```

`DataTable`の名前に対して注文API、注文固有の空状態、注文画面の再試行が埋め込まれると、別の画面で再利用しにくくなる。通信状態の判断を画面の担当へ置くと、表示部品は行の表示と選択通知に集中できる。APIクライアント生成、手書きのfetch、queryライブラリなどの選択は、プロジェクトの実在する通信境界と既存の契約に合わせる。

## キャッシュとページング

キャッシュは、同じデータを識別する条件、更新後に古い表示を破棄する方法、ページの連続性を確認して選ぶ。URL、利用者、テナント、filter、sort、pageやcursorなど、結果を変える条件をキャッシュのキーや依存へ含める。

```tsx
// NG - accountIdがキーから抜け、同じfilterの別アカウントと結果を共有する
const key = ['orders', { filter, page }]

// OK - 結果を決める条件を一つのキーへ含める
const key = ['orders', { accountId, filter, page }]
```

cursorやoffsetという方式名だけでキャッシュの可否は決まらない。途中の追加・削除・並び替え、古いcursor、ページの重複や欠落、更新後の再取得が実際のサーバーとライブラリの契約に合うかを確認する。キャッシュを使わず画面内のスナップショットを保持する選択も、表示中の一覧をどう更新するかが説明できる場合に選ぶ。

## フロントエンドとサーバーの責務

サーバーが正本として判定する業務状態と、ブラウザだけが知る表示・入力状態を分ける。クライアントで入力中の検証、並べ替え、絞り込み、プレビューを行うことは、業務の最終判定を置き換えない限り画面の責務である。

| 判断の種類 | 主な担当 |
|------------|---------|
| 在庫、価格、権限、業務上の状態遷移 | サーバーの判定を正本とし、UIは結果と許可された操作を表示する |
| 必須入力、文字数、入力形式など入力中のフィードバック | ブラウザで即時に示し、必要な制約はサーバーでも検証する |
| 受信済み一覧の表示順、表示フィルタ、プレビュー | UIの表示状態として管理する |
| 金額・日時・単位の表示 | 利用者のlocaleと表示文脈に合わせ、操作や保存へ流用する値と分ける |

```tsx
// NG - クライアントだけで成功状態を確定し、サーバーへ操作を送らない
function CheckoutButton({ cart }: { cart: Cart }) {
  const canCheckout = cart.total >= 1000 && cart.items.every(item => item.stock > 0)
  return <button type="button" onClick={() => showCompleted()} disabled={!canCheckout}>注文を確定</button>
}

// OK - 画面が確定操作を担当し、表示ボタンは意図を通知する
function CheckoutScreen({ cart }: { cart: Cart }) {
  const canShowCheckout = cart.total >= 1000
  async function handleCheckout() {
    showResult(await checkout(cart.id))
  }
  return <CheckoutButton disabled={!canShowCheckout} onCheckout={handleCheckout} />
}

function CheckoutButton({ disabled, onCheckout }: {
  disabled: boolean
  onCheckout: () => void
}) {
  return <button type="button" disabled={disabled} onClick={onCheckout}>注文を確定</button>
}
```

クライアントの表示用計算は画面状態として扱い、業務の確定状態はサーバー操作の結果を受けて更新する。

## ブラウザの安全性

ブラウザ固有の入力境界と実行境界を確認する。ユーザー入力をHTMLやURLへ埋め込む場合のエスケープ、HTMLを直接挿入する場合の出所、外部遷移先、CookieやWeb Storageの扱い、CSRFが必要な通信、別オリジンとの境界を、実装とサーバーの契約で確認する。

```tsx
// NG - ユーザー入力をHTMLとして解釈させる
return <div dangerouslySetInnerHTML={{ __html: comment }} />

// OK - 文字列として表示し、HTMLが必要なら許可する出所とサニタイズ境界を明示する
return <div>{comment}</div>
```

認証、認可、暗号、サーバー側の入力検証など深いセキュリティ判断はセキュリティの専門知識へ委ねる。フロントエンドでは、ブラウザから外へ出る値と、ブラウザへ入る値の境界が追跡できることを確認する。

## 変更しやすいコンポーネント境界

コンポーネントを分ける根拠は行数やpropsの数ではなく、責務、変更理由、再利用単位、状態の担当である。表示部品へ画面固有のAPI呼び出しやルーティングを隠すと、表示の見た目を変える変更が通信手順にも影響する。

| 条件 | 意味・選択肢 |
|------|-------------|
| 同じ表示を複数画面で使い、画面ごとに取得方法が異なる | 表示部品は値と操作入口を受け、取得は画面側に置く |
| 部品自身が入力や開閉だけを管理し、外部へ影響を出さない | 部品内の状態として閉じる |
| 複数の枝が同じ事実を読み書きする | 共通の担当へ状態と操作を集める |
| 汎用部品に画面固有の条件分岐が増える | 画面処理と表示の変更理由を分ける |
| propsの委譲があるが意味を変えない | 階層の深さだけで分割方法を決めず、所有と変更影響を確認する |

「コンテナ」「presentational」などの名称は、責務を説明する補助語として使える。変更理由と操作経路が自然に分かれる境界を作る。
