# React知識

Reactのprops、state、Context、reducer、Effect、hookを、GUIの階層と状態遷移へ具体化する。Reactの慣用的な書き方と、MVPでいう厳密なPassive Viewは同じ概念ではないが、表示部品と画面・領域の動作を裁定する処理を分けるという設計意図で対応させる。Reactのコンポーネント階層は論理的な構成であり、PortalでDOM上の配置が変わっても、状態の所有とContext・イベントの経路はその論理階層から追う。

## Propsとstateの所有

propsは親から渡される入力、stateはコンポーネントが保持して操作で変化させる記憶である。各stateには一つの担当を置き、同じ事実を複数のコンポーネントで複製しない。Reactではstateを持つコンポーネントの位置が、どの部分木へ表示が反映されるかを決める。

| 状態の性質 | Reactでの配置例 |
|------------|----------------|
| 一つの部品に閉じるfocus、開閉、入力途中 | その部品の `useState` または `useReducer` |
| 兄弟部品が共有する選択や入力 | 最小共通の親で保持し、propsとイベントハンドラで渡す |
| 深い部分木へ同じ値と操作を配る | Contextで値を配り、状態の保持・更新はProviderやreducerなどの担当に置く |
| 状態と遷移を一箇所で裁定する | `useReducer`、dispatch、画面用hookなど |
| サーバー由来のデータと再取得 | query hookやデータ取得担当が取得条件、失敗、更新を扱う |

### 共有選択を一つにする

一覧と詳細が同じ選択を表示する場合は、共通の親で選択を保持する。子がそれぞれ `selectedId` を持つと、片方だけ更新される経路や同期Effectが生まれる。

```tsx
// NG - 二つの部品が同じ選択を別々に保持する
function List() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemList selectedId={selectedId} onSelect={setSelectedId} />
}

function Detail() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemDetail id={selectedId} onSelect={setSelectedId} />
}

// OK - 共通の親が選択を保持し、表示と操作を配る
function Workspace() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return (
    <>
      <ItemList selectedId={selectedId} onSelect={setSelectedId} />
      <ItemDetail id={selectedId} />
    </>
  )
}
```

選択の担当が変わるときは、表示部品のAPIだけでなく、一覧の操作、詳細の表示、URLや通信が選択に反応する経路を同じ変更として確認する。

## Propsの変更とstateの寿命

propsをstateの初期値へコピーすると、その値は最初のrenderでしか読み取られない。親の値が変わるたびに表示を変えるcontrolled componentなのか、識別子が変わったときだけ編集草稿を作り直すcomponentなのかを決める。

```tsx
// NG - documentTitleが変わっても初回の草稿を表示し続ける
function TitleEditor({ documentTitle }: { documentTitle: string }) {
  const [draft, setDraft] = useState(documentTitle)
  return <input aria-label="文書名" value={draft} onChange={event => setDraft(event.target.value)} />
}

// OK - 編集中の値を親のstateとして扱う
function TitleEditor({ title, onChange }: {
  title: string
  onChange: (title: string) => void
}) {
  return <input aria-label="文書名" value={title} onChange={event => onChange(event.target.value)} />
}
```

ローカルな編集草稿が必要な場合は、どの文書IDで草稿を破棄して初期化するかを、`key`でcomponentの境界を変える、明示的なイベントで初期化するなどの形で表す。propsの変更をEffectで無条件にstateへコピーし続けると、利用者の入力を上書きしやすい。

## 派生値とstateの重複

propsやstateから毎回計算できる値は、別のstateとして保存しない。派生値をEffectで同期すると、render直後に一度古い表示が出たり、更新順によって送信値がずれたりする。

```tsx
// NG - visibleItemsとallSelectedをEffectで正規stateとして同期する
const [visibleItems, setVisibleItems] = useState<Item[]>([])
const [allSelected, setAllSelected] = useState(false)

useEffect(() => {
  const nextVisibleItems = items.filter(item => matches(item, filter))
  setVisibleItems(nextVisibleItems)
  setAllSelected(
    nextVisibleItems.length > 0 && nextVisibleItems.every(item => selectedIds.has(item.id)),
  )
}, [items, filter, selectedIds])

// OK - 正規stateから表示と判定を導出する
const visibleItems = items.filter(item => matches(item, filter))
const allSelected = visibleItems.length > 0 && visibleItems.every(item => selectedIds.has(item.id))
```

計算量が実測上の問題になる場合は `useMemo` などで計算を再利用できるが、依存と結果の契約を明示する。依存していない値や小さな計算を形式だけでmemo化しない。

## Contextは値を配る仕組み

Contextは、木の深い場所へ値を渡す経路を提供する。Contextそのものが状態を保持したり、遷移を裁定したりするわけではない。Provider内の `useState`、`useReducer`、外部storeなどが状態を持ち、Contextはその値と操作入口を利用者へ配る構成を取れる。

```tsx
const CartContext = createContext<CartContextValue | null>(null)

function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, initialCart)
  return (
    <CartContext.Provider value={{ state, dispatch }}>
      {children}
    </CartContext.Provider>
  )
}

function CartTotal() {
  const context = useContext(CartContext)
  if (!context) throw new Error('CartTotal must be inside CartProvider')
  return <output>{formatTotal(context.state.items)}</output>
}
```

Contextへ画面固有の通信手順や複数の正規stateを詰め込むと、利用者がどの操作で状態を変えるか追いにくくなる。深い部品が必要とする値と操作だけを配り、遷移と副作用の裁定はProvider内のreducerや画面用hookなど、責務が読める担当へ置く。

## Reducerと画面の状態機械

`useReducer`は、現在stateと操作意図から次のstateを決める境界を作る。これは画面や領域のMediatorに対応するReactの実現方法の一つであり、特別なクラスを作ることを要求しない。表示部品はreducerを直接理解せず、表示値と意図の通知を受ける。

```tsx
type Phase = 'editing' | 'submitting' | 'success' | 'failure'
type State = { phase: Phase; message: string | null }
type Event =
  | { type: 'submit' }
  | { type: 'retry' }
  | { type: 'completed' }
  | { type: 'failed'; message: string }

const initialState: State = { phase: 'editing', message: null }

function reducer(state: State, event: Event): State {
  if (event.type === 'submit' && state.phase === 'editing') {
    return { phase: 'submitting', message: null }
  }
  if (event.type === 'retry' && state.phase === 'failure') {
    return { phase: 'submitting', message: null }
  }
  if (event.type === 'completed' && state.phase === 'submitting') {
    return { phase: 'success', message: '保存しました' }
  }
  if (event.type === 'failed' && state.phase === 'submitting') {
    return { phase: 'failure', message: event.message }
  }
  return state
}

function SaveView({ state, onSave, onRetry }: {
  state: State
  onSave: () => void
  onRetry: () => void
}) {
  return (
    <section>
      {state.message && <p role="status">{state.message}</p>}
      <SaveButton disabled={state.phase !== 'editing'} onSave={onSave} />
      {state.phase === 'failure' && <RetryButton onRetry={onRetry} />}
    </section>
  )
}
```

この例は状態遷移と描画を抜き出している。画面側は `useReducer(reducer, initialState)` で状態を保持し、操作ハンドラが現在状態から受理を判断して保存を開始する。完了・失敗をdispatchし、そのstateと操作ハンドラを `SaveView` へ渡す。reducerは純粋に次のstateを返し、表示部品は描画パラメータと通知を扱う。複数の操作入口は同じ保存ハンドラへ集める。

## 重複submitと複数の操作入口

フォーム送信、ボタンのclick、キーボードのEnterなどは、同じ操作へ到達しうる。入口ごとに通信を呼ぶと一回の意図が二重送信になる。HTMLのform送信を一つの入口にし、ボタンは `type="submit"` として、送信可能かどうかは現在stateから決める。

```tsx
// NG - clickとsubmitが同じ通信を二度呼ぶ
<form onSubmit={submitOrder}>
  <button type="submit" onClick={submitOrder}>注文する</button>
</form>

// OK - formのsubmitだけが操作をdispatchする
<form onSubmit={event => {
  event.preventDefault()
  dispatch({ type: 'submit' })
}}>
  <button type="submit" disabled={state.phase === 'submitting'}>注文する</button>
</form>
```

操作の重複を、各ボタンの条件式や `stopPropagation` の追加で隠さない。操作意図がどの入口から来ても、同じreducer、command、画面用hookへ入り、現在stateで受理・拒否される構造にする。

## Effectと外部システムの同期

`useEffect`はrenderの外にあるシステムとの同期に使う。接続、購読、timer、外部APIとの同期など、開始と停止が対になる処理をEffectへ置き、利用者の一回の操作に属する送信や通知はイベントハンドラまたはcommandへ置く。

Effectが読むprops、state、component内で作った値や関数が再実行条件になる。依存配列をlintへの対処として固定・追加せず、同期する対象と再実行の理由を先に決める。

```tsx
// NG - roomIdが変わっても接続を作り直せず、古い部屋を表示し続ける
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [])

// OK - roomIdごとに接続を作り、再実行前とunmount時に解放する
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [roomId, onMessage])
```

`onMessage`がrenderごとに変わるため不要な再接続が起きるなら、handlerの責務を整理し、安定した参照へ移す、Effectの外へ出す、またはイベント処理へ移す。依存を削るだけで古い値を許容しない。

### 通信とcleanup

URLや識別子の変化で取得をやり直す場合は、その値を依存へ含め、前の取得をキャンセルできるようにする。失敗を空配列へ変換して成功と区別できなくしない。

```tsx
useEffect(() => {
  const controller = new AbortController()
  setResult({ status: 'loading' })

  void loadDocument(documentId, controller.signal)
    .then(document => setResult({ status: 'success', document }))
    .catch(error => {
      if (error.name !== 'AbortError') setResult({ status: 'error', error })
    })

  return () => controller.abort()
}, [documentId])
```

初期ロードが一度だけという仕様なら、Effectがreactive valueを読まない構造にして空の依存配列を使う。filter、URL、ページング、明示的な再取得が仕様なら、それらを依存、query key、操作入力へ反映する。loading表示、message、dialogの開閉だけを初期ロードの再実行条件にしない。

## Custom Hook

custom hookは、Reactのstate、Effect、ref、Context、query、form、イベント変換を、呼び出し元から責務が追える形で組み合わせる境界にできる。statefulなUI制御はhookへ、純粋計算は通常の関数へ分けると、画面のMediatorと表示部品の境界が読みやすい。

同じstateful hookを複数のコンポーネントから呼んでも、stateは共有されない。共有が必要なら、最小共通のコンポーネントで一度だけ呼んでprops・callbackで渡すか、Providerや外部storeへ置く。

```tsx
// NG - 同じhookを呼べば共有されると誤認する
function List() {
  const selection = useSelection()
  return <ItemList selection={selection} />
}

function Detail() {
  const selection = useSelection()
  return <ItemDetail selection={selection} />
}

// OK - hookを一つの担当で呼び、結果を両方へ渡す
function Workspace() {
  const selection = useSelection()
  return (
    <>
      <ItemList selection={selection} />
      <ItemDetail selection={selection} />
    </>
  )
}
```

hookがJSXやpropsに似たオブジェクトを返す形式だけで設計を決めない。hookが画面固有の通信を隠す、同じ副作用を複数回起こす、画面固有の型やcomponentへ循環依存する場合は、その依存方向と変更理由を見直す。

## TanStack Queryとキャッシュの条件

TanStack Queryでは、取得結果を変える条件を `queryKey` と `queryFn` の両方へ明示する。条件付きで一部のキーを省略すると、別の利用者・URL・filterの結果を同じcacheへ置く。

```tsx
import { useQuery } from '@tanstack/react-query'

// NG - filterがないとaccountIdがキーへ入らない
const result = useQuery({
  queryKey: ['orders', filter ? { accountId, filter, page } : { page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})

// OK - useQueryのキーへ取得条件を常に含める
const result = useQuery({
  queryKey: ['orders', { accountId, filter, page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})
```

更新後はinvalidation、refetch、またはライブラリの契約に沿ったcache更新で、古い表示を正規データとして残さない。cursorやoffsetのページングでは、ページの連続性、重複、欠落、並び替え後の表示をサーバーとqueryライブラリの契約で確認する。

## Props型とhookの境界

Props型とhookの配置は、共有範囲、公開契約、変更理由、依存方向で決める。一つのcomponentだけが使う型はcomponentの近くに置くと描画契約を追いやすい。複数componentの共有契約、公開API、独立したドメインモデルは別ファイルへ置ける。

hookは状態、イベント、派生値を返し、呼び出し側で表示へ束ねる形にすると、画面の動作とcomponentの描画を分けやすい。Props型を共有する構成も、循環依存や不要な画面固有結合を生まず、同じ変更理由で管理されるなら選択できる。

## 参考資料

- React: Thinking in React
  https://react.dev/learn/thinking-in-react
- React: Sharing State Between Components
  https://react.dev/learn/sharing-state-between-components
- React: Responding to Events
  https://react.dev/learn/responding-to-events
- React: Passing Data Deeply with Context
  https://react.dev/learn/passing-data-deeply-with-context
- React: useEffect
  https://react.dev/reference/react/useEffect
- React: You Might Not Need an Effect
  https://react.dev/learn/you-might-not-need-an-effect
- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
