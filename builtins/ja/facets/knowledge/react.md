# React知識

## effect と再実行

`useEffect` は「いつ再実行してよいか」を明示する仕組みであり、初期化処理の置き場ではない。初期表示で1回だけ行う処理か、依存変化で再実行すべき処理かを先に決める。


```tsx
// 避ける例: 初期取得なのに不安定な関数依存を経由して再実行されうる
const fetchList = useCallback(async () => {
  await loadItems()
}, [setIsLoading, errorPage])

useEffect(() => {
  fetchList()
}, [fetchList])

// 例: 初期表示の一度きりロードとして固定
useEffect(() => {
  void loadItemsOnMount()
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## Context と Provider value

Context の `value={{ ... }}` は Provider の再描画ごとに新しい参照になる。Context から受け取った関数を `useEffect` の依存に置くと、利用側が意図せず再実行ループに入ることがある。


```tsx
// 避ける例: Context 関数をそのまま初期取得 effect の依存に使う
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData(setIsLoading, errorPage)
}, [setIsLoading, errorPage])

// 例: 初期取得は mount-only、Context 関数は内部で使う
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData({ setIsLoading, errorPage })
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## 初期表示ロード

初期表示ロードは「画面を開いたときに1回だけ必要な処理」か、「状態変化に応じて再実行する処理」かを区別する。後者でない限り、再取得のトリガーは明示的なユーザー操作や URL/検索条件の変化に限定する。

| 条件 | 動作 |
|------|------|
| 初期表示で一覧を1回読むだけ | mount-only effect |
| フィルタ、ページング、URL パラメータ変更で再取得 | その状態を依存に明示 |
| loading state や message/dialog の表示状態が変わる | 初期取得の再実行条件とは分離する |

## データフェッチライブラリのキャッシュ適性

データフェッチライブラリ（React Query 等）のキャッシュはすべてのデータ取得に適するわけではない。データの変動頻度とページング方式で判断する。


cursor ページングとキャッシュの相性が悪い理由:

- nextId（cursor）が古くなり、次ページ取得で欠落や重複が発生する
- 削除された行を基準に次ページを取ると取りこぼしが起きる
- タブ復帰時に途中ページを自動再取得すると「いま見えている一覧」とサーバーの実態がズレる

データフェッチライブラリを使う場合でもキャッシュを実質無効にする必要があるなら、そのライブラリを使う意味がない。画面の責務として毎回取り直す方が安全。

```tsx
// 避ける例: 変動する cursor paged 一覧に React Query のキャッシュを適用
const { data } = useInfiniteQuery({
  queryKey: ['records'],
  queryFn: ({ pageParam }) => fetchRecords(pageParam),
  getNextPageParam: (last) => last.nextId,
  staleTime: 5 * 60 * 1000,  // 途中で削除されうるのにキャッシュを効かせている
})

// 例: local state で画面の責務として取得
const [records, setRecords] = useState<Record[]>([])
const [nextId, setNextId] = useState<string | undefined>()

const loadMore = async () => {
  const result = await fetchRecords(nextId)
  setRecords(prev => [...prev, ...result.items])
  setNextId(result.nextId)
}
```

## custom hook の責務

React custom hook は「React の state/effect/ref を使う状態遷移」に限定する。純粋計算だけなら custom hook ではなく関数モジュールでよい。
custom hook 内の `useState` は呼び出し元ごとに別インスタンスになる。同じ hook を複数コンポーネントから呼んでも状態は共有されない。
共有状態が必要な場合は、最小共通親で hook を1回だけ呼んで props で渡すか、Context/外部 store に移す。


### Props 型の配置と hook の境界

コンポーネント専用の Props 型は、基本的にそのコンポーネントと同じファイルへ置く。別ファイルの型定義は、複数コンポーネントで共有する契約、外部公開 API、またはドメインモデルとして独立した意味を持つ場合に使う。


```tsx
// 避ける例: hook が特定 component の Props 契約に依存している
import type { DialogProps } from './Dialog'

export function useDialog(): { dialogProps: DialogProps } {
  return { dialogProps: { open, onOpenChange } }
}

// 例: component 専用 Props は component 側に閉じる
interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function Dialog(props: DialogProps) {
  return <Modal {...props} />
}

// 例: hook は UI 状態と操作を返し、呼び出し側で component に渡す
const dialog = useDialog()
return <Dialog open={dialog.open} onOpenChange={dialog.setOpen} />
```

## exhaustive-deps の扱い

`react-hooks/exhaustive-deps` は無条件で従うものではなく、effect の意味を壊さない範囲で従う。mount-only 初期化で依存を増やすと挙動が壊れる場合は、理由を残して抑制する。
