# React知識

Reactの標準的なstate、effect、Context、hook、query、formの使い方を、GUIの責務と実行時の契約に沿って理解する。

## stateと状態所有

useStateはhookを呼び出したコンポーネントごとに独立したstateを持つ。複数のコンポーネントで共有したい場合は、最小共通のownerでhookを呼ぶ、Contextやstoreへ置く、reducerとdispatchで更新入口をまとめるなど、必要な範囲に合わせて選ぶ。

| 状態や契約 | Reactでの実現例 |
|------------|-----------------|
| 部分木に閉じるUI状態 | useState、useReducer |
| 複数コンポーネントで共有する状態 | Context、Provider、store |
| 状態と操作を一箇所で裁定する | reducer、dispatch、custom hook |
| サーバー由来データ | query hook、cache、invalidation、refetch |
| フォーム入力と検証 | controlled/uncontrolled input、form library、binding |

Contextやreducerを使うこと、必要なRoot所有stateを置くこと、小さな画面で状態を集中させることを形式だけで避けない。誰が状態を所有し、どの操作で更新され、どの表示へ反映されるかを追跡する。

## effectと再実行

`useEffect`はReactのrender外にあるシステムとの同期を表す。接続、購読、タイマーなど、開始と停止が対になった処理へ使い、汎用的な初期化置き場にはしない。初期表示で1回だけ行う処理か、依存変化で再実行すべき処理かを先に決める。送信や通知のように1回の利用者操作へ属する副作用は、その操作handlerや状態所有者のcommandへ置く。

Effectが読むprops、state、component内で作った値や関数は、Effectが同期する条件に含める。依存配列はlintを黙らせるために選ぶ値ではなく、Effectのコードと再実行の目的から決まる。不要な依存を減らすときは、値をEffectの外へ移す、処理をhandlerへ移す、独立した同期を別Effectへ分けるなど、コードの責務を先に変える。

外部接続や購読を作るEffectはcleanupで解放する。開発時にsetupとcleanupが追加で実行されても、重複購読や未解放の接続を残さない構造にする。空の依存配列は、Effect内にreactive valueがなく、mount時の同期とcleanupが実際の契約に合う場合に限って使う。

```tsx
// 避ける例: 初期取得なのに不安定な関数依存を経由して再実行されうる
const fetchList = useCallback(async () => {
  await loadItems()
}, [setIsLoading, errorPage])

useEffect(() => {
  fetchList()
}, [fetchList])

// 例: module scopeの関数と固定値だけを読む初期ロードを、cleanup付きで一度だけ同期する契約
import { loadItemsOnMount } from './items-api'
const initialEndpoint = '/api/items'

useEffect(() => {
  const controller = new AbortController()
  void loadItemsOnMount(initialEndpoint, controller.signal)
  return () => controller.abort()
}, [])
```

## ContextとProvider value

Contextの`value={{ ... }}`はProviderの再描画ごとに新しい参照になる。Contextから受け取った関数をEffectの依存に置くと、利用側が意図せず再実行ループに入ることがある。value参照の変化による再renderやEffect再実行と、機能が実際に必要とする再取得条件を区別する。Contextのdispatchや操作関数をevent handlerから使うことは標準的な構成であり、Contextを使ったという理由だけで拒否しない。

```tsx
// この例ではProviderが毎回新しいContext関数を作り、loading更新の無関係な再描画で初期取得が繰り返される。
// 避ける例: Context関数をそのまま初期取得Effectの依存に使う
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData(setIsLoading, errorPage)
}, [setIsLoading, errorPage])

// 例: Contextの操作はユーザー操作から通知し、初期取得は独立した同期にする
import { loadInitialData } from './items-api'
const { dispatch } = useAppContext()
const initialEndpoint = '/api/items'

useEffect(() => {
  const controller = new AbortController()
  void loadInitialData(initialEndpoint, controller.signal)
  return () => controller.abort()
}, [])

function handleRetry() {
  dispatch({ type: 'retry' })
}
```

## 初期表示ロード

初期表示ロードはリアクティブな再取得と分けて扱う。初回取得をmount-onlyとする契約ならその条件を保ち、フィルタ、URL、ページング、明示的なユーザー操作など契約で定めた条件が再取得を要求する場合は、その値や操作を依存、query key、操作入力へ反映する。loading、message、dialogの表示状態だけでは初期取得を再実行しない。

| 条件 | 動作 |
|------|------|
| 初期表示で一覧を1回読むだけ | 契約を記録したmount-only Effect |
| フィルタ、ページング、URLパラメータ変更で再取得 | その状態を依存、query key、操作入力へ明示 |
| loading stateやmessage、dialogの表示状態が変わる | 初期取得の再実行条件とは分離する |

## Query、キャッシュ、ページング

データフェッチライブラリのキャッシュは、データと整合性契約で選ぶ。単一リソースの詳細や安定した一覧はquery cacheを使える。cursorやoffsetの一覧も、queryの識別、invalidation、refetch、ページ連続性、重複・欠落、表示中スナップショットの契約が明示されていればquery cacheやinfinite queryを使える。

cursorやoffsetは、それだけでキャッシュに不適な方式ではない。途中の追加・削除・並び替え、古いcursor、一部ページだけの再取得は、欠落、重複、サーバーと異なる表示を生むことがある。query cache、画面ownerのstate、別方式を選ぶ前に条件を確認する。ライブラリとサーバーの契約があれば、infinite queryが先頭から順にページを再取得しcursorの連続性を保つこともある。

```tsx
// 変動するcursor一覧をcacheする前に、サーバーとqueryの契約を確認する。
const { data } = useInfiniteQuery({
  queryKey: ['records', accountId],
  queryFn: ({ pageParam }) => fetchRecords(accountId, pageParam),
  getNextPageParam: (last) => last.nextId,
})

// 表示スナップショットにその契約が必要なら、画面ownerがlocal stateを使える。
const [records, setRecords] = useState<Record[]>([])
const [nextId, setNextId] = useState<string | undefined>()

const loadMore = async () => {
  const result = await fetchRecords(accountId, nextId)
  setRecords(prev => [...prev, ...result.items])
  setNextId(result.nextId)
}
```

## custom hookの責務

`use*`関数は、Reactのstate、effect、ref、Context、query、form、イベント変換を、責務と所有者が追跡できる形で組み合わせる境界にできる。純粋計算は通常の関数へ置くことが多いが、hookの名前や返り値の形式だけで設計を拒否しない。useContextで共有dispatchを公開するhookも標準的なhook合成である。

custom hook内のuseStateは呼び出し元ごとに別インスタンスになる。同じstateful hookを複数コンポーネントから呼んでも状態は共有されない。共有状態が必要な場合は、最小共通のownerでhookを1回だけ呼んでpropsやcallbackで渡すか、Contextや外部storeへ移す。

hookがJSXを返すこと自体を不備とはしない。hookが操作の所有者を隠す、不透明または重複した副作用を起こす、表示契約を壊す場合の実害を確認する。

## Props型の配置とhookの境界

1つのcomponent専用Props型は基本的にcomponentと同じファイルへ置く。複数componentで共有する契約、公開API、または独立した意味を持つドメインモデルは別ファイルへ置ける。hookはcomponent専用Props型をimportせず、状態・イベント・派生値を返し、呼び出し側でcomponent propsへ変換する。

```tsx
// 避ける例: hookが特定componentのProps契約に依存している
import type { DialogProps } from './Dialog'

export function useDialog(): { dialogProps: DialogProps } {
  return { dialogProps: { open, onOpenChange } }
}

// 例: component専用Propsはcomponent側に閉じる
interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function Dialog(props: DialogProps) {
  return <Modal {...props} />
}

// 例: hookはUI状態と操作を返し、呼び出し側でcomponentへ渡す
const dialog = useDialog()
return <Dialog open={dialog.open} onOpenChange={dialog.setOpen} />
```

## exhaustive-depsの扱い

空の依存配列やlint抑制を、lintを黙らせるための常用手段にしない。Effectが同期する対象とreactive valueを先に明確にし、空配列を使うならreactive valueを読まないコードへ変更して契約を成立させる。再実行が必要なEffectを空の依存配列で固定しない。

## 公式資料

- React: Removing Effect Dependencies
  https://react.dev/learn/removing-effect-dependencies
- React: Extracting State Logic into a Reducer
  https://react.dev/learn/extracting-state-logic-into-a-reducer
- React: Scaling Up with Reducer and Context
  https://react.dev/learn/scaling-up-with-reducer-and-context
- TanStack Query: Infinite Queries
  https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
