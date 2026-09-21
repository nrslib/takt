# GUI知識

GUIを、Rootを起点とする階層、状態の範囲と寿命、表示と動作の分離、操作意図の通知、現在状態に基づく判断として理解する。

## Rootを起点とする階層

画面に属するコンポーネントは、Rootから辿れるUIの部分木として構成する。ここでいう階層は、責務と状態を持つコンポーネントの論理的な包含関係であり、DOMの配置そのものを表すものではない。Rootは画面全体を組み立てる起点であり、すべての状態や副作用をRootへ集める場所ではない。階層の深さや中間コンポーネントの数は、責務と変更理由に応じて決める。

```
Root
└── 画面または領域の動作を裁定する担当
    ├── 表示部品
    └── 表示部品
```

図は責務の関係を示すものであり、階層数やファイル配置は責務と変更理由に応じて決める。小さな画面ではRootと動作の担当を同じコンポーネントに置け、独立した領域にはその領域の担当を置ける。各表示部品がどの部分木に属し、状態と操作をどの担当が裁定するかを追える構造にする。

| 条件 | 意味・選択肢 |
|------|-------------|
| UIがRootから辿れ、各部分木の責務が読める | 階層が変更経路を示している |
| 複数の表示部品が同じ状態を一貫して扱う必要がある | それらを含む最小の部分木に担当を置く候補 |
| ある領域が独立して配置され、独自の状態と通信を持つ | その領域の担当として閉じる候補 |
| Rootが画面の組み立てだけを行い、状態を必要な部分木へ委譲する | Rootの責務と状態の責務が分かれている |

## 状態の範囲と寿命

状態は、その事実を一貫させる必要がある最小の部分木で保持する。配置は「最上位へ集める」ではなく、状態を使う範囲と、状態が生きる時間で決める。

| 状態の性質 | 配置の考え方 |
|------------|--------------|
| hover、focus、入力途中、開閉など一つの部品に閉じる状態 | その部品または小さな部分木に置く |
| 一覧と詳細など近い複数の枝で共有する選択状態 | 両方を含む最小の担当へ置き、各表示部品へ渡す |
| 画面の送信中、完了、失敗など画面内の遷移状態 | 画面または領域の動作を裁定する担当へ置く |
| 複数画面で生存するセッションや設定 | Rootに近い共有機構を選び、利用範囲と寿命を合わせる |
| 外部から取得するデータと取得中・失敗の状態 | 取得と更新を担当する部分木の担当へ置く |

### 選択状態を共有する

一覧と詳細が同じ選択を表示するなら、選択IDを二つの部品で別々に持たず、両方を含む最小の担当が一つだけ持つ。選択という一つの事実を一覧からの操作と詳細への表示へ同じ経路で渡すと、変更箇所と反映範囲が追いやすい。

## 表示と動作の分離

厳密なMVPのPassive Viewは、描画に必要なパラメータを受け取り、利用者の操作意図を通知する。状態遷移、通信、共有状態の変更、外部副作用を、表示部品自身の判断として実行しない。

Mediatorは、画面または領域の状態と操作意図を受け、現在状態でその操作を受理するか拒否するか、次の状態と副作用をどうするかを決める担当である。Mediatorというクラス名や専用オブジェクトを使うことが目的ではなく、その裁定責務が表示部品から分かれていることが目的になる。

```tsx
// NG - 表示部品が画面の通信と遷移を裁定する
function SaveButton({ orderId }: { orderId: string }) {
  return (
    <button type="button" onClick={async () => {
      await fetch(`/orders/${orderId}`, { method: 'POST' })
      window.location.assign('/orders')
    }}>
      保存
    </button>
  )
}

// OK - 表示部品は描画パラメータと意図の通知だけを扱う
function SaveButton({ disabled, onSave }: {
  disabled: boolean
  onSave: () => void
}) {
  return <button type="button" disabled={disabled} onClick={onSave}>保存</button>
}
```

小さな画面ではRootとMediatorの処理を一つの関数に同居させつつ、表示部品の入力・出力と、現在状態を読んで操作を裁定する処理を区別する。フレームワークの状態・入力連携を使う場合も、表示と裁定の責務が読める境界を保つ。

## 操作意図とイベント経路

コンポーネント間のcallback、責任連鎖、Mediatorによる状態判断は別の概念である。操作意図を上位の担当へ渡す経路と、担当外の意図を次の担当へ委譲する条件を、コンポーネントの論理階層から追えるようにする。

| 経路 | 役割 |
|------|------|
| callbackやbinding | 子や入力部品が、公開された操作入口へ意図を直接通知する |
| Chain of Responsibility | ある担当が意図を扱えるか判断し、扱えなければ次の担当へ渡す |
| Mediator | 現在状態と意図から受理・拒否、遷移、必要な副作用を裁定する |

callbackは直接の操作通知、責任連鎖は担当外の意図を次の担当へ渡す経路として設計する。担当外の意図をどこへ渡すか、受理した後に祖先が同じ意図を再処理しないことを明示する。

## 現在状態に基づく判断

状態機械は、状態、操作意図、遷移、遷移に伴う副作用を明示する。状態によって受理できる操作が変わる画面では、表示部品が個別に判断せず、画面または領域のMediatorが現在状態から決める。

```ts
type Phase = 'editing' | 'submitting' | 'success' | 'failure'
type ScreenState = { phase: Phase; message: string | null }
type Intent =
  | { type: 'submit' }
  | { type: 'retry' }
  | { type: 'completed' }
  | { type: 'failed'; message: string }

function transition(state: ScreenState, intent: Intent): ScreenState {
  if (intent.type === 'submit' && state.phase === 'editing') {
    return { phase: 'submitting', message: null }
  }
  if (intent.type === 'submit') {
    return state
  }
  if (intent.type === 'retry' && state.phase === 'failure') {
    return { phase: 'submitting', message: null }
  }
  if (intent.type === 'completed' && state.phase === 'submitting') {
    return { phase: 'success', message: '保存しました' }
  }
  if (intent.type === 'failed' && state.phase === 'submitting') {
    return { phase: 'failure', message: intent.message }
  }
  return state
}

function viewParameters(state: ScreenState) {
  return {
    submitDisabled: state.phase !== 'editing',
    retryVisible: state.phase === 'failure',
    message: state.message,
  }
}
```

`submitting`中の再送信を同じ状態のまま拒否し、`completed`や`failed`を受けたときだけ表示パラメータを変える。「操作を受け付けるか」と「表示へどう反映するか」を同じ状態モデルから決める例である。

| 観測できる構造 | 意味・選択肢 |
|----------------|-------------|
| 表示部品が描画パラメータを受け、意図を操作入口へ通知する | Passive Viewの責務が保たれている |
| 画面または領域の担当が現在状態を読み、操作の受理・拒否と遷移を決める | Mediatorの裁定が追跡できる |
| Rootから表示部品と状態の担当へ辿れる | 階層と所有範囲が読める |
| 中間部品が意図の意味を変えずに委譲する | 深さだけで構造の問題とは限らない |
| 表示部品が通信、遷移、共有状態変更を個別に判断する | 表示と動作の境界を見直す候補 |
| 同じ意図が複数の操作経路から二度実行される | 入口と責任連鎖を整理する候補 |

## 参考資料

- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
