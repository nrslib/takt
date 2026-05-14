# React知識

## effect と再実行

`useEffect` は「いつ再実行してよいか」を明示する仕組みであり、初期化処理の置き場ではない。初期表示で1回だけ行う処理か、依存変化で再実行すべき処理かを先に決める。

| 基準 | 判定 |
|------|------|
| 初期表示の一度きりのロードなのに、再生成される関数参照を依存に置く | REJECT |
| 再取得条件が明確でないのに、Context/Provider 由来関数を依存に置く | REJECT |
| mount-only 初期化を `useEffect(..., [])` で表現し、意図をコメントで残す | OK |
| 依存変化時の再取得が仕様として必要で、その依存を明示している | OK |

```tsx
// REJECT - 初期取得なのに不安定な関数依存を経由して再実行されうる
const fetchList = useCallback(async () => {
  await loadItems()
}, [setIsLoading, errorPage])

useEffect(() => {
  fetchList()
}, [fetchList])

// OK - 初期表示の一度きりロードとして固定
useEffect(() => {
  void loadItemsOnMount()
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## Context と Provider value

Context の `value={{ ... }}` は Provider の再描画ごとに新しい参照になる。Context から受け取った関数を `useEffect` の依存に置くと、利用側が意図せず再実行ループに入ることがある。

| 基準 | 判定 |
|------|------|
| Context 由来関数の参照安定性を確認せず、effect 依存に入れる | REJECT |
| Provider 側で value の安定性が保証されていないのに mount effect の依存に使う | REJECT |
| Context 関数はイベントハンドラから使い、初期取得は mount-only に閉じる | OK |
| Provider 側で value 安定化を行い、再取得条件も仕様で定義する | OK |

```tsx
// REJECT - Context 関数をそのまま初期取得 effect の依存に使う
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData(setIsLoading, errorPage)
}, [setIsLoading, errorPage])

// OK - 初期取得は mount-only、Context 関数は内部で使う
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData({ setIsLoading, errorPage })
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## 初期表示ロード

初期表示ロードは「画面を開いたときに1回だけ必要な処理」か、「状態変化に応じて再実行する処理」かを区別する。後者でない限り、再取得のトリガーは明示的なユーザー操作や URL/検索条件の変化に限定する。

| 条件 | 推奨 |
|------|------|
| 初期表示で一覧を1回読むだけ | mount-only effect |
| フィルタ、ページング、URL パラメータ変更で再取得 | その状態を依存に明示 |
| loading state 更新で再取得が走る | REJECT |
| message 表示や dialog 開閉で再取得が走る | REJECT |

## データフェッチライブラリのキャッシュ適性

データフェッチライブラリ（React Query 等）のキャッシュはすべてのデータ取得に適するわけではない。データの変動頻度とページング方式で判断する。

| データ特性 | キャッシュ | 判定 |
|-----------|----------|------|
| 単一リソースの詳細（設定値、プロフィール等） | 有効 | OK |
| 安定した一覧（マスタデータ、変更頻度が低い） | 有効 | OK |
| cursor ページングかつ途中で追加・削除・並び替えが起きる一覧 | 無効 | local state で取得 |
| offset ページングかつ途中でデータ変動が起きる一覧 | 無効 | local state で取得 |

cursor ページングとキャッシュの相性が悪い理由:

- nextId（cursor）が古くなり、次ページ取得で欠落や重複が発生する
- 削除された行を基準に次ページを取ると取りこぼしが起きる
- タブ復帰時に途中ページを自動再取得すると「いま見えている一覧」とサーバーの実態がズレる

データフェッチライブラリを使う場合でもキャッシュを実質無効にする必要があるなら、そのライブラリを使う意味がない。画面の責務として毎回取り直す方が安全。

```tsx
// REJECT - 変動する cursor paged 一覧に React Query のキャッシュを適用
const { data } = useInfiniteQuery({
  queryKey: ['records'],
  queryFn: ({ pageParam }) => fetchRecords(pageParam),
  getNextPageParam: (last) => last.nextId,
  staleTime: 5 * 60 * 1000,  // 途中で削除されうるのにキャッシュを効かせている
})

// OK - local state で画面の責務として取得
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

| 基準 | 判定 |
|------|------|
| React の state/effect を使わないのに `use*` と命名する | 警告 |
| 純関数群を custom hook として扱う | 警告 |
| stateful な UI 制御は custom hook に、純粋計算は function module に分ける | OK |
| 共有状態が必要な複数コンポーネントで同じ stateful hook を個別に呼ぶ | REJECT |
| hook が JSX を返す | REJECT |

## exhaustive-deps の扱い

`react-hooks/exhaustive-deps` は無条件で従うものではなく、effect の意味を壊さない範囲で従う。mount-only 初期化で依存を増やすと挙動が壊れる場合は、理由を残して抑制する。

| 基準 | 判定 |
|------|------|
| ルールに従うためだけに不要な再実行依存を追加する | REJECT |
| lint 抑制を無言で入れる | 警告 |
| mount-only の理由をコメントで説明して抑制する | OK |
| 再実行が必要な effect なのに `[]` にする | REJECT |
