# React知識

Reactでは、propsで親から値を受け、stateで変化する値を持ち、描画で画面を作る。画面の通信や遷移はハンドラやhookへ置き、表示用コンポーネントへ埋め込まない。

## Propsとstate

propsは親から渡される入力、stateはコンポーネントが操作で変える値である。同じ事実を二つの`useState`で持たず、値を使う範囲と残る時間に合う位置で保持する。

```tsx
// NG - 一覧と詳細が選択を別々に持つ
function List() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemList selectedId={selectedId} onSelect={setSelectedId} />
}

function Detail() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemDetail id={selectedId} onSelect={setSelectedId} />
}

// OK - 共通の親が一つの選択を持つ
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

入力途中の値や開閉状態を一つのコンポーネントだけで使うなら、そのコンポーネントで持てる。複数のコンポーネントが使う選択や入力は共通の親で持つ。複数画面に残す値は、画面を切り替えても残るProviderや外部ストアで持つ。

## Propsの変更とstateの寿命

`useState`へ渡した初期値は、後からpropsが変わってもstateへ反映されない。親の値を表示し続ける入力欄なら、値と変更コールバックをpropsで受け取る。

```tsx
// NG - documentTitleが変わっても初回の草稿を表示する
function TitleEditor({ documentTitle }: { documentTitle: string }) {
  const [draft, setDraft] = useState(documentTitle)
  return (
    <input
      aria-label="文書名"
      value={draft}
      onChange={event => setDraft(event.target.value)}
    />
  )
}

// OK - 親の値を表示し、変更を親へ知らせる
function TitleEditor({ title, onChange }: {
  title: string
  onChange: (title: string) => void
}) {
  return (
    <input
      aria-label="文書名"
      value={title}
      onChange={event => onChange(event.target.value)}
    />
  )
}
```

確定するまで親へ反映しない下書きは、コンポーネント内のstateに持てる。別の文書へ切り替えるときは、文書IDを`key`にして作り直すか、切替操作で初期化する。propsの変化をEffectで毎回コピーすると、編集中の値まで上書きしてしまう。

## 派生値は計算する

propsやstateから計算できる値を別のstateに保存しない。Effectで派生値を同期すると、更新直後に古い値を表示したり、更新順で判定がずれたりする。

```tsx
// NG - 表示一覧と全選択をEffectで別のstateに保存する
const [visibleItems, setVisibleItems] = useState<Item[]>([])
const [allSelected, setAllSelected] = useState(false)

useEffect(() => {
  const next = items.filter(item => matches(item, filter))
  setVisibleItems(next)
  setAllSelected(next.length > 0 && next.every(item => selectedIds.has(item.id)))
}, [items, filter, selectedIds])

// OK - 同じ条件から毎回計算する
const visibleItems = items.filter(item => matches(item, filter))
const allSelected = visibleItems.length > 0
  && visibleItems.every(item => selectedIds.has(item.id))
```

計算量が実際に問題なら`useMemo`などで再利用する。何を依存にして計算を省くかを説明できる状態で使う。

## Contextは値を渡す

Contextは、祖先のProviderが渡した値を子孫から読む仕組みである。Providerで`useState`や`useReducer`を使い、その状態と更新関数を渡せる。

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

Contextで保存関数を渡せば、深い子も同じ保存処理を呼べる。stateの計算はreducerで行い、通信の開始は渡された関数で行う。

## Reducerと保存通信

reducerは現在のstateとeventから次のstateを返す純粋な関数である。保存通信はハンドラで開始し、開始時・成功時・失敗時にdispatchする。reducerの中で通信や通知を実行しない。

## 重複submitを防ぐ

次は`onSave`を受け取るフォームの例である。formのsubmitを一つの入口にし、ボタンのclick側では`onSave`を呼ばない。

```tsx
function SaveForm({ disabled, onSave }: {
  disabled: boolean
  onSave: () => void
}) {
  return (
    <form onSubmit={event => {
      event.preventDefault()
      if (!disabled) onSave()
    }}>
      <button type="submit" disabled={disabled}>保存</button>
    </form>
  )
}
```

Enterキーなど別の入口から来てもsubmitへ入り、保存を一度だけ通知する。

PortalでDOM上の配置が異なる部品でも、ReactのイベントはReactツリーに沿って祖先へ伝わる。

## Effectと外部システム

`useEffect`は描画の外にある接続、購読、timer、取得などとReactを同期する。利用者の一回の操作に属する保存や通知は、Effectではなくイベントハンドラやcommandへ置く。

Effect内で読むprops、state、コンポーネント内で宣言した変数や関数を依存配列に含める。接続先が変わったら接続を作り直す、というように同期する対象を決める。

```tsx
// NG - roomIdが変わっても古い部屋への接続を使い続ける
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [])

// OK - roomIdごとに接続し、再実行前とunmount時に閉じる
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [roomId, onMessage])
```

callbackの参照が描画ごとに変わり、機能上不要な再接続が実際に起きるなら、ハンドラを安定させる、Effectの外へ出す、またはイベント処理へ移す。依存を削って古い値を使わせない。

識別子の変更で取得をやり直す場合は、識別子を依存へ含め、前の取得をcleanupでキャンセルする。Abortされた結果を失敗表示へ変換しない。

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

## Reactの実行規則

Hookはコンポーネントまたはcustom hookのトップレベルで呼び、条件分岐やloopの中で呼ばない。描画中は通信、通知、DOM操作、外部変数の変更を行わず、propsとstateを直接変更しない。

並べ替え可能な一覧では、配列の添字ではなく項目のIDを`key`に使う。`key`が変わるとReactは別のコンポーネントとして扱い、stateを初期化する。

## Custom Hook

custom hookは、state、Effect、ref、Context、query、form、イベント変換を一つの画面の動作としてまとめられる。純粋な計算だけなら通常の関数に分ける。

hook内部の`useState`で作ったstateは、hookの呼び出しごとに別になる。Context、query、外部storeを読むhookは共有された値を返せるため、hookの名前だけで共有を判断せず、内部で何を読み書きするかを見る。

## TanStack Queryとcache

TanStack Queryでは、取得結果を変える条件を`queryKey`と`queryFn`へ同じ意味で渡す。条件によってkeyの項目を省略すると、別の利用者やfilterの結果を同じcacheへ置く。

```tsx
import { useQuery } from '@tanstack/react-query'

// NG - filterがない場合にaccountIdもkeyから消える
const result = useQuery({
  queryKey: ['orders', filter ? { accountId, filter, page } : { page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})

// OK - 取得条件を常に同じkeyへ含める
const result = useQuery({
  queryKey: ['orders', { accountId, filter, page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})
```

更新後はinvalidation、再取得、またはTanStack Queryのcache更新で古い結果を置き換える。ページングでは、cursor、sort、filter、snapshotがサーバーの結果と一致し、重複や欠落を扱えることを確認する。

## Props型とhookの配置

一つのコンポーネントだけが使うProps型は、その近くに置く。複数の部品が使う型は、共通で使える場所へ置く。画面用hookから表示に必要な値と操作関数を返せば、コンポーネントはそれらを使って描画できる。

## 参考資料

- React: Thinking in React
  https://react.dev/learn/thinking-in-react
- React: Sharing State Between Components
  https://react.dev/learn/sharing-state-between-components
- React: Responding to Events
  https://react.dev/learn/responding-to-events
- React: Passing Data Deeply with Context
  https://react.dev/learn/passing-data-deeply-with-context
- React: Reusing Logic with Custom Hooks
  https://react.dev/learn/reusing-logic-with-custom-hooks
- React: useEffect
  https://react.dev/reference/react/useEffect
- React: You Might Not Need an Effect
  https://react.dev/learn/you-might-not-need-an-effect
- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
