# フロントエンド専門知識

## フロントエンドの層構造

依存方向は一方向。逆方向の依存は禁止。

```
app/routes/ → features/ → shared/
```

| 層 | 責務 | ルール |
|---|------|--------|
| `app/routes/` | ルート定義のみ | UIロジックを持たない。feature の View を呼ぶだけ |
| `features/` | 機能単位の自己完結モジュール | 他の feature を直接参照しない |
| `shared/` | 全 feature 横断の共有コード | feature に依存しない |

ルートファイルは薄いラッパーに徹する。

```tsx
// CORRECT - ルートは薄い
// app/routes/schedule-management.tsx
export default function ScheduleManagementRoute() {
  return <ScheduleManagementView />
}

// WRONG - ルートにロジックを書く
export default function ScheduleManagementRoute() {
  const [filter, setFilter] = useState('all')
  const { data } = useListSchedules({ filter })
  return <ScheduleTable data={data} onFilterChange={setFilter} />
}
```

View コンポーネント（`features/*/components/*-view.tsx`）がデータ取得・状態管理を担当する。

```
ルート（route） → View（データ取得・状態管理） → 子コンポーネント（表示）
```

### 画面追加時のルーティング配線

新しい画面を追加したら、画面コンポーネントを作るだけで終わらせず、到達経路まで配線する。Router、メニュー、導線のどこから到達するかを計画時点で固定する。


```tsx
// 例: 画面実装と route 配線を同時に追加
<Route path="/contreg" element={<ContainerRegisterPage />} />

// 避ける例: 画面実装はあるが到達経路がない
// src/pages/ContainerRegisterPage.tsx は存在する
// Router には route がない
```

到達経路は Router だけではない。メニュー、一覧からの遷移ボタン、ダイアログ内の確定導線、外部画面からのリンクなど、利用者が実際にたどる入口を基準に確認する。

### 外部UIライブラリとの統合

DataGrid、日付ピッカー、チャート、仮想リストのような外部 UI ライブラリは、型が通っても実行時に落ちることがある。特にメジャーバージョン差分では、props 名や state model の互換性を shallow なモックだけでは検出できない。


### アクセシビリティ契約

accessible name、role、state は支援技術とテストが参照する UI 契約である。新しい UI 要素には適切なアクセシビリティ属性を追加する一方で、既存要素の契約を変える場合は文言変更と同じく利用者影響のある変更として扱う。


## コンポーネント設計

コンポーネント境界は行数や state の有無ではなく、責務、変更理由、再利用単位、データ所有者で決める。独立して変わるセクションや副作用は分離候補だが、密接に協調する表示を機械的に細分化しない。props の受け渡しは深さだけで状態管理を導入せず、複数の枝が同じ状態を共有するなど所有者が変わるときに配置を見直す。

良いコンポーネント:
- 単一責務: 1つのことをうまくやる
- 自己完結: 必要な依存が明確
- テスト可能: 副作用が分離されている

コンポーネント分類:

| 種類 | 責務 | 例 |
|------|------|-----|
| Container | データ取得・状態管理 | `UserListContainer` |
| Presentational | 表示のみ | `UserCard` |
| Layout | 配置・構造 | `PageLayout`, `Grid` |
| Utility | 共通機能 | `ErrorBoundary`, `Portal` |

### UIプリミティブの設計原則

shared/components/ui/ に配置するHTML要素ラッパーの設計ルール:

- `forwardRef` で ref を転送する（外部からの制御を可能にする）
- `className` を受け取り、外からスタイル拡張可能にする
- ネイティブ props をスプレッドで透過する（`...props`）
- variants は別ファイルに分離する（`button.variants.ts`）

```tsx
// CORRECT - プリミティブの設計
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, size, className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </button>
    )
  }
)

// WRONG - refもclassNameも透過しない閉じたコンポーネント
export const Button = ({ label, onClick }: { label: string; onClick: () => void }) => {
  return <button className="fixed-style" onClick={onClick}>{label}</button>
}
```

ディレクトリ構成:
```
features/{feature-name}/
├── components/
│   ├── {feature}-view.tsx      # メインビュー（子を組み合わせる）
│   ├── {sub-component}.tsx     # サブコンポーネント
│   └── index.ts
├── hooks/
├── types.ts
└── index.ts
```

## 状態管理

子コンポーネントは自身で状態を変更しない。イベントを親にバブリングし、親が状態を操作する。
複数コンポーネントが同じ状態を読む・更新する場合は、まずそれらの最小共通親に状態を配置し、子には props とイベントコールバックで渡す。

```tsx
// 子が自分で状態を変更（NG）
const ChildBad = ({ initialValue }: { initialValue: string }) => {
  const [value, setValue] = useState(initialValue)
  return <input value={value} onChange={e => setValue(e.target.value)} />
}

// 親が状態を管理、子はコールバックで通知（OK）
const ChildGood = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  return <input value={value} onChange={e => onChange(e.target.value)} />
}

const Parent = () => {
  const [value, setValue] = useState('')
  return <ChildGood value={value} onChange={setValue} />
}
```

例外（子がローカルstate持ってOK）:
- UI専用の一時状態（ホバー、フォーカス、アニメーション）
- 親に伝える必要がない完全にローカルな状態


### 正規状態と派生状態

state にはユーザー入力、サーバーデータ、UIの一時状態などの正規状態を保持する。正規状態から計算できる表示値、集計値、選択状態、並び替え結果、グルーピング結果は派生値として扱い、独立した state として保持しない。


状態配置の判断基準:

| 状態の性質 | 推奨配置 |
|-----------|---------|
| UIの一時的な状態（モーダル開閉等） | ローカル（useState） |
| フォームの入力値 | ローカル or フォームライブラリ |
| 近い親子・兄弟コンポーネントで共有 | 最小共通親で管理して props で渡す |
| 深い階層・画面横断で共有 | Context or 状態管理ライブラリ |
| サーバーデータのキャッシュ | TanStack Query等のデータフェッチライブラリ |

## APIクライアント生成

プロジェクトがAPIクライアント生成ツール（Orval、openapi-typescript等）を採用している場合、新規APIエンドポイントとの接続には必ず生成されたクライアントを使用する。


確認手順:
1. プロジェクトにAPI生成設定があるか確認（orval.config.ts, openapi-generator 等）
2. 既存の生成済みクライアントの使用パターンを確認
3. 新規エンドポイントは生成パイプラインに追加し、生成されたフックを使う

## 初期表示ロードと再取得境界

初期表示ロードはリアクティブな再取得と分けて扱う。URL、フィルタ、ページング、明示的な更新操作がない限り、初回ロードは mount-only に保ち、不安定なコールバック参照に結び付けない。


## データ取得

API呼び出しはルート（View）コンポーネントで行い、子コンポーネントにはpropsで渡す。

```tsx
// CORRECT - ルートでデータ取得、子に渡す
const OrderDetailView = () => {
  const { data: order, isLoading, error } = useGetOrder(orderId)
  const { data: items } = useListOrderItems(orderId)

  if (isLoading) return <Skeleton />
  if (error) return <ErrorDisplay error={error} />

  return (
    <OrderSummary
      order={order}
      items={items}
      onItemSelect={handleItemSelect}
    />
  )
}

// WRONG - 子コンポーネントが自分でデータ取得
const OrderSummary = ({ orderId }) => {
  const { data: order } = useGetOrder(orderId)
  // ...
}
```

UIの状態変更でパラメータが変わる場合（週切り替え、フィルタ等）:

状態もViewレベルで管理し、コンポーネントにはコールバックを渡す。

```tsx
// CORRECT - 状態もViewで管理
const ScheduleView = () => {
  const [currentWeek, setCurrentWeek] = useState(startOfWeek(new Date()))
  const { data } = useListSchedules({
    from: format(currentWeek, 'yyyy-MM-dd'),
    to: format(endOfWeek(currentWeek), 'yyyy-MM-dd'),
  })

  return (
    <WeeklyCalendar
      schedules={data?.items ?? []}
      currentWeek={currentWeek}
      onWeekChange={setCurrentWeek}
    />
  )
}

// WRONG - コンポーネント内で状態管理+データ取得
const WeeklyCalendar = ({ facilityId }) => {
  const [currentWeek, setCurrentWeek] = useState(...)
  const { data } = useListSchedules({ facilityId, from, to })
  // ...
}
```

例外（コンポーネント内フェッチが許容されるケース）:

| ケース | 理由 |
|--------|------|
| 独立ウィジェット | どのページにも置ける自己完結型コンポーネント |
| 無限スクロール | スクロール位置というUI内部状態に依存 |
| 検索オートコンプリート | 入力値に依存したリアルタイム検索 |
| リアルタイム更新 | WebSocket/Pollingでの自動更新 |
| モーダル内の詳細取得 | 開いたときだけ追加データを取得 |

### 独立ウィジェットパターン

どのページにも「置くだけ」で動く自己完結型コンポーネント（通知バッジ、ログインユーザー表示等）。

ウィジェットと判定する条件（すべて満たすこと）:
- 親のデータと完全に無関係
- 親の状態に影響を与えない
- どのページに置いても同じ動作をする

1つでも満たさない場合は View でデータ取得し、props で渡す。

```tsx
// WRONG - orderId という親のコンテキストに依存。ウィジェットではない
const OrderStatusWidget = ({ orderId }: { orderId: string }) => {
  const { data } = useGetOrder(orderId)
  return <StatusBadge status={data?.status} />
}

// CORRECT - 親のデータフローに参加するならpropsで受け取る
const OrderStatusWidget = ({ status }: { status: OrderStatus }) => {
  return <StatusBadge status={status} />
}
```


### 画面専用APIの利用

画面が必要とするデータは、その画面専用のAPIエンドポイントから取得する。既存の汎用APIを流用して画面を組み立てない。APIが存在しない場合は、フロントで回避するのではなく、バックエンドに専用エンドポイントの追加を先に行う。


```tsx
// 避ける例: 一覧APIを詳細画面で流用
const DetailScreen = ({ itemId }) => {
  const { data: list } = useListItems({ date })
  const item = list?.items.find(i => i.id === itemId)
  return <Detail item={item} />
}

// 例: 詳細画面は詳細APIを使う
const DetailScreen = ({ itemId }) => {
  const { data: item } = useGetItem(itemId)
  return <Detail item={item} />
}
```

### 通信スコープの限定

通信はタブ・画面単位で閉じる。他タブのために先読みしない。定期ポーリングは表示中の画面だけで行う。


## 共有コンポーネントと抽象化

### カテゴリ分類

shared コンポーネントは責務別にサブディレクトリで分類する。

```
shared/components/
├── ui/              # HTMLプリミティブのラッパー（Button, Card, Badge, Dialog）
├── form/            # フォーム入力要素（TextInput, Select, Checkbox）
├── layout/          # ページ構造・ルート保護（Layout, ProtectedRoute）
├── navigation/      # ナビゲーション（Tabs, BackLink, SidebarItem）
├── data-display/    # データ表示（Table, DetailField, Calendar）
├── feedback/        # 状態フィードバック（LoadingState, ErrorState）
├── domain/          # ドメイン固有だが横断的（StatusBadge, CategoryBadge）
└── index.ts         # barrel export
```

| カテゴリ | 配置基準 |
|---------|---------|
| ui/ | HTML要素を薄くラップ。ドメイン知識を持たない |
| form/ | ラベル・エラー・必須マークを統合したフォーム部品 |
| layout/ | ページ全体の骨格。認証・ロール制御を含む |
| domain/ | 特定ドメインに依存するが、複数 feature で共有 |

ui/ と domain/ の判断基準: ドメイン用語がコンポーネント名やpropsに含まれるなら domain/。

### 共有化の基準

同じパターンのUIは共有コンポーネント化する。インラインスタイルのコピペは禁止。同じ役割・意味状態（プレースホルダー、無効、未確認等）を表す UI は、同じ共有コンポーネントまたは明示されたデザイン契約の中では文言・スタイル・読み上げを揃える。表示文脈（画面階層、密度、テーマ等）による表現差は許容するが、意味と操作契約は維持する。

```tsx
// WRONG - インラインスタイルのコピペ
<button className="p-2 text-[var(--text-secondary)] hover:...">
  <X className="w-5 h-5" />
</button>

// CORRECT - 共有コンポーネント使用
<IconButton onClick={onClose} aria-label="閉じる">
  <X className="w-5 h-5" />
</IconButton>
```

共有コンポーネント化すべきパターン:
- アイコンボタン（閉じる、編集、削除等）
- ローディング/エラー表示
- ステータスバッジ
- タブ切り替え
- ラベル+値の表示（詳細画面）
- 検索入力
- カラー凡例

過度な汎用化を避ける:

```tsx
// WRONG - IconButtonに無理やりステッパー用バリアントを追加
export const iconButtonVariants = cva('...', {
  variants: {
    variant: {
      default: '...',
      outlined: '...',  // ステッパー専用、他で使わない
    },
    size: {
      medium: 'p-2',
      stepper: 'w-8 h-8',  // outlinedとセットでしか使わない
    },
  },
})

// CORRECT - 用途別に専用コンポーネント
export function StepperButton(props) {
  return (
    <button className="w-8 h-8 rounded-full border ..." {...props}>
      <Plus className="w-4 h-4" />
    </button>
  )
}
```

別コンポーネントにすべきサイン:
- 「このvariantはこのsizeとセット」のような暗黙の制約がある
- 追加したvariantが元のコンポーネントの用途と明らかに違う
- 使う側のprops指定が複雑になる

### テーマ差分とデザイントークン

同じ機能コンポーネントを再利用しつつ見た目だけ変える場合は、デザイントークン + テーマスコープで管理する。

原則:
- 色・余白・角丸・影・タイポをトークン（CSS Variables）として定義する
- 画面/ロール別の差分はテーマスコープ（例: `.consumer-theme`, `.admin-theme`）で上書きする
- コンポーネント内に16進カラー値（`#xxxxxx`）を直書きしない
- ロジック差分（API・状態管理）と見た目差分（トークン）を混在させない

```css
/* tokens.css */
:root {
  --color-bg-page: #f3f4f6;
  --color-surface: #ffffff;
  --color-text-primary: #1f2937;
  --color-border: #d1d5db;
  --color-accent: #2563eb;
}

.consumer-theme {
  --color-bg-page: #f7f8fa;
  --color-accent: #4daca1;
}
```

```tsx
// same component, different look by scope
<div className="consumer-theme">
  <Button variant="primary">Submit</Button>
</div>
```

運用ルール:
- 共通UI（Button/Card/Input/Tabs）はトークン参照のみで実装する
- feature側はテーマ共通クラス（例: `surface`, `title`, `chip`）を利用し、装飾ロジックを重複させない
- 追加テーマ実装時は「トークン追加 → スコープ上書き → 既存コンポーネント流用」の順で進める

レビュー観点:
- 直書き色・直書き余白のコピペがないか
- 同一UIパターンがテーマごとに別コンポーネント化されていないか
- 見た目変更のためにデータ取得/状態管理が改変されていないか

NG例:
- 見た目差分のために `ButtonConsumer`, `ButtonAdmin` を乱立
- featureコンポーネントごとに色を直書き
- テーマ切り替えのたびにAPIレスポンス整形ロジックを変更

## 抽象化レベルの評価

### 条件分岐と抽象化

レンダリング分岐は利用者が見る状態と責務に沿って表現する。同じ意味・契約・変更理由を持つ実装が2つ確認できた時点で、共通コンポーネントや変換関数の所有者を判断する。分岐数や構文だけでコンポーネント分割やポリモーフィズムを要求しない。

### 抽象度の不一致検出

| パターン | 問題 | 修正案 |
|---------|------|--------|
| データ取得ロジックがJSXに混在 | 読みにくい | カスタムフックに抽出 |
| ビジネスロジックがコンポーネントに混在 | 責務違反 | hooks/utilsに分離 |
| スタイル計算ロジックが散在 | 保守困難 | ユーティリティ関数に抽出 |
| 同じ変換処理が複数箇所に | DRY違反 | 共通関数に抽出 |

良い抽象化の例:

```tsx
// 条件分岐が肥大化
function UserBadge({ user }) {
  if (user.role === 'admin') {
    return <span className="bg-red-500">管理者</span>
  } else if (user.role === 'moderator') {
    return <span className="bg-yellow-500">モデレーター</span>
  } else if (user.role === 'premium') {
    return <span className="bg-purple-500">プレミアム</span>
  } else {
    return <span className="bg-gray-500">一般</span>
  }
}

// Mapで抽象化
const ROLE_CONFIG = {
  admin: { label: '管理者', className: 'bg-red-500' },
  moderator: { label: 'モデレーター', className: 'bg-yellow-500' },
  premium: { label: 'プレミアム', className: 'bg-purple-500' },
  default: { label: '一般', className: 'bg-gray-500' },
}

function UserBadge({ user }) {
  const config = ROLE_CONFIG[user.role] ?? ROLE_CONFIG.default
  return <span className={config.className}>{config.label}</span>
}
```

```tsx
// 抽象度が混在
function OrderList() {
  const [orders, setOrders] = useState([])
  useEffect(() => {
    fetch('/api/orders')
      .then(res => res.json())
      .then(data => setOrders(data))
  }, [])

  return orders.map(order => (
    <div>{order.total.toLocaleString()}円</div>
  ))
}

// 抽象度を揃える
function OrderList() {
  const { data: orders } = useOrders()  // データ取得を隠蔽

  return orders.map(order => (
    <OrderItem key={order.id} order={order} />
  ))
}
```

## フロントエンドとバックエンドの責務分離

### 表示形式の責務

バックエンドは「データ」を返し、フロントエンドが「表示形式」に変換する。

```tsx
// フロントエンド: 表示形式に変換
export function formatPrice(amount: number): string {
  return `¥${amount.toLocaleString()}`
}

export function formatDate(date: Date): string {
  return format(date, 'yyyy年M月d日')
}
```


### ドメインロジックの配置（SmartUI排除）

ドメインロジック（ビジネスルール）はバックエンドに配置。フロントエンドは状態の表示・編集のみ。

ドメインロジックとは:
- 集約のビジネスルール（在庫判定、価格計算、ステータス遷移）
- バリデーション（業務制約の検証）
- 不変条件の保証

フロントエンドの責務:
- サーバーから受け取った状態を表示
- ユーザー入力を収集し、コマンドとしてバックエンドに送信
- UI専用の一時状態管理（フォーカス、ホバー、モーダル開閉）
- 表示形式の変換（フォーマット、ソート、フィルタ）


良い例 vs 悪い例:

```tsx
// 避ける例: フロントエンドでビジネスルール
function OrderForm({ order }: { order: Order }) {
  const totalPrice = order.items.reduce((sum, item) =>
    sum + item.price * item.quantity, 0
  )
  const canCheckout = totalPrice >= 1000 && order.items.every(i => i.stock > 0)

  return <button disabled={!canCheckout}>注文確定</button>
}

// GOOD - バックエンドから受け取った状態を表示
function OrderForm({ order }: { order: Order }) {
  // totalPrice, canCheckout はサーバーから受け取る
  return (
    <>
      <div>{formatPrice(order.totalPrice)}</div>
      <button disabled={!order.canCheckout}>注文確定</button>
    </>
  )
}
```

```tsx
// 避ける例: フロントエンドでステータス遷移判定
function TaskCard({ task }: { task: Task }) {
  const canStart = task.status === 'pending' && task.assignee !== null
  const canComplete = task.status === 'in_progress' && /* 複雑な条件... */

  return (
    <>
      <button onClick={startTask} disabled={!canStart}>開始</button>
      <button onClick={completeTask} disabled={!canComplete}>完了</button>
    </>
  )
}

// GOOD - サーバーが許可するアクションを返す
function TaskCard({ task }: { task: Task }) {
  // task.allowedActions = ['start', 'cancel'] など、サーバーが計算
  const canStart = task.allowedActions.includes('start')
  const canComplete = task.allowedActions.includes('complete')

  return (
    <>
      <button onClick={startTask} disabled={!canStart}>開始</button>
      <button onClick={completeTask} disabled={!canComplete}>完了</button>
    </>
  )
}
```

例外（フロントエンドにロジックを置いてもOK）:

| ケース | 理由 |
|--------|------|
| UI専用バリデーション | 「必須入力」「文字数制限」等のUXフィードバック（サーバー側でも検証必須） |
| クライアント側フィルタ/ソート | サーバーから受け取ったリストの表示順序変更 |
| 表示条件の分岐 | 「ログイン済みなら詳細表示」等のUI制御 |
| リアルタイムフィードバック | 入力中のプレビュー表示 |

判断基準: 「この計算結果がサーバーとズレたら業務が壊れるか?」
- YES → バックエンドに配置（ドメインロジック）
- NO → フロントエンドでもOK（表示ロジック）

## 横断的関心事の処理層

横断的関心事は適切な層で処理する。コンポーネント内に散在させない。

| 関心事 | 処理層 | パターン |
|-------|--------|---------|
| 認証トークン付与 | APIクライアント層 | リクエストインターセプタ |
| 認証エラー（401/403） | APIクライアント層 | レスポンスインターセプタ |
| ルート保護 | レイアウト層 | ProtectedRoute + Outlet |
| ロール別振り分け | レイアウト層 | ユーザー種別による分岐 |
| ローディング/エラー表示 | View（Container）層 | 早期リターン |

```tsx
// CORRECT - 横断的関心事はインターセプタ層で処理
// api/axios-instance.ts
instance.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// WRONG - 各コンポーネントで個別にトークンを付与
const MyComponent = () => {
  const token = localStorage.getItem('auth_token')
  const { data } = useQuery({
    queryFn: () => fetch('/api/data', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  })
}
```

```tsx
// CORRECT - ルート保護はレイアウト層で
// shared/components/layout/protected-route.tsx
function ProtectedRoute() {
  const { isAuthenticated } = useAuthStore()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <Layout><Outlet /></Layout>
}

// routes でラップ
<Route element={<ProtectedRoute />}>
  <Route path="/dashboard" element={<DashboardView />} />
</Route>

// WRONG - 各ページで個別に認証チェック
function DashboardView() {
  const { isAuthenticated } = useAuthStore()
  if (!isAuthenticated) return <Navigate to="/login" />
  return <div>...</div>
}
```

## パフォーマンス


最適化チェックリスト:
- `React.memo` / `useMemo` / `useCallback` は適切か
- 大きなリストは仮想スクロール対応か
- Code Splittingは適切か
- 画像はlazy loadingされているか

アンチパターン:

```tsx
// レンダリングごとに新しいオブジェクト
<Child style={{ color: 'red' }} />

// 定数化 or useMemo
const style = useMemo(() => ({ color: 'red' }), []);
<Child style={style} />
```

## アクセシビリティ


チェックリスト:
- セマンティックHTMLを使用しているか
- ARIA属性は適切か（過剰でないか）
- キーボードナビゲーション可能か
- スクリーンリーダーで意味が通じるか
- カラーコントラストは十分か

## TypeScript/型安全性


## フロントエンドセキュリティ


## テスタビリティ
