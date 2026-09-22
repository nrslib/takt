# React知識

Reactでは、propsで親から値を受け、stateで変化する値を持ち、描画で画面を作る。画面の通信や遷移はハンドラやhookへ置き、表示用コンポーネントへ埋め込まない。GUIのMediatorの役割は、画面用handler、custom hook、Context、reducerなどReact標準の仕組みで、操作と現在stateから処理と次のstateを決める形で担う。

## Propsとstate

propsは親から渡される入力、stateはコンポーネントが操作で変える値である。同じ事実を二つの`useState`で持たず、値を使う範囲と残る時間に合う位置で保持する。複数の部品が同じ対象の識別子や入力を使うなら、それらを調整する親または画面で一つに管理し、propsと操作の通知を渡す。部品内だけで使う入力途中の値や開閉状態は、その部品で持つ。複数画面に残す値は、Providerや外部storeなど寿命に合う共有元で持つ。

## Propsの変更とstateの寿命

`useState`へ渡した初期値は、後からpropsが変わってもstateへ反映されない。親の値を表示し続ける入力欄は、値と変更ハンドラをpropsで受け取る。確定するまで親へ反映しない下書きはコンポーネント内のstateに持ち、別の対象へ切り替えるときは対象の安定した識別子を`key`にして作り直すか、切替操作で初期化する。propsの変化をEffectで毎回コピーすると、編集中の値まで上書きする。

## 派生値は計算する

propsやstateから計算できる一覧、件数、全選択、ラベルなどを別のstateとして保存しない。描画中に同じ条件から計算すれば、更新順による古い表示や判定のずれを防げる。計算量が実際に問題なら`useMemo`などで再利用し、計算に使う値を依存として明示する。

## Contextは値を渡す

`createContext`で作ったContextは、祖先のProviderが渡した値を子孫から読む仕組みである。Providerで`useState`や`useReducer`を使い、state、dispatch、操作を開始するhandlerなど、画面の複数部品が共有する値を渡す。`useContext`で読む値の範囲と寿命を確認し、局所的な値まで共有しない。

## Mediator、Reducer、操作

画面用handlerやcustom hookはMediatorとして操作の通知を受け、現在stateと対象を確認して、操作を受理または拒否し、受理した操作に必要な処理、拒否の結果、次のstate、表示する値を決める。form、button、keyboardなど異なる入口から同じ操作が来ても、同じMediatorの判断を通す。操作要素の`disabled`表示だけを判定にせず、処理を開始する箇所でもstateと対象を確認する。

`reducer`は現在stateとeventから次のstateを返す純粋な関数である。通信、timer、通知などの副作用はreducerの外でhandlerが開始し、開始・成功・失敗の結果を`dispatch`してstateへ反映する。拒否、入力不備、権限不足、競合など、結果に応じた表示もこの状態の流れから作る。

Reactのstate更新は次のrenderで反映され、`dispatch`直後に同じhandlerが読むstateは、そのhandler内では変わらない。描画前に次の通知が届く経路では、先の受理を反映しない古いstateで後続通知を判定し、受け付けられない操作の通信やtimerを開始しないよう、受理判定と副作用開始を同じ制御経路で扱い、受理した操作だけを開始する。続く通知は、先の受理を反映したstateで判断できるようにする。実装方式はフレームワークの慣用方法から条件に合うものを選ぶ。

フォーム送信は、`onSubmit`、formの`action`、その他の標準的な仕組みなど、選んだ入口から処理担当へ一度だけ通知し、同じ状態判断を通す。Enterキーなどフォームを送信する操作も同じ状態判断を通し、送信処理を重複実行しない。PortalでDOM上の配置が異なる部品でも、ReactのイベントはReactツリーに沿って祖先へ伝わる。

## Effectと外部システム

`useEffect`は描画の外にある接続、購読、timer、取得などとReactを同期する。利用者の一回の操作に属する送信や通知は、Effectではなくイベントハンドラやcommandへ置く。

Effect内で読むprops、state、コンポーネント内で宣言した値や関数を依存配列に含める。依存は再接続・再取得したい条件と一致させ、lintの警告だけを理由に削らない。不要な再実行が起きる場合は、handlerを安定させる、Effectの外へ出す、同期対象を分けるなど、実際の同期対象を整理する。

接続、購読、timer、取得は再実行前とunmount時にcleanupする。識別子の変更で取得をやり直す場合は識別子を依存に含め、`AbortController`などで前の取得をキャンセルする。Abortされた結果を失敗表示へ変換せず、古い応答が新しいstateを上書きしないよう競合を扱う。

## Reactの実行規則

Hookはコンポーネントまたはcustom hookのトップレベルで呼び、条件分岐やloopの中で呼ばない。描画中は通信、通知、DOM操作、外部変数の変更などの副作用を行わず、propsとstate、その内部の値を直接変更しない。

並べ替え可能な一覧では配列の添字ではなく、項目の安定した識別子を`key`に使う。`key`が変わるとReactは別のコンポーネントとして扱い、stateを初期化するため、位置とstateの寿命を意図に合わせる。

## Custom Hook

画面や領域を担当するコンポーネントは、custom hookでstate、Effect、ref、Context、query、form、イベント変換などを一つの画面の動作としてまとめ、表示部品へ必要な値と操作の通知先を渡せる。純粋な計算だけなら通常の関数に分ける。hook内部の`useState`で作ったstateはhookの呼び出しごとに別になる。Context、query、外部storeを読むhookは共有された値を返せるため、hookの名前ではなく内部で何を読み書きするかを見る。

## TanStack Queryとcache

TanStack Queryの`useQuery`では、取得結果を変える条件を`queryKey`と`queryFn`へ同じ意味で渡す。利用者、tenant、対象の識別子、filter、sort、page、cursorなどの条件をkeyから省くと、異なる結果が同じcacheへ置かれる。

更新後はinvalidation、再取得、またはTanStack Queryのcache更新で古い結果を置き換える。ページングでは、cursor、sort、filter、snapshotがサーバーの結果と一致し、途中の更新による重複や欠落を扱えることを確認する。

## Props型とhookの配置

一つのコンポーネントだけが使うProps型は、その近くに置く。複数の部品が使う型は共通で使える場所へ置く。画面用hookから表示に必要な値と操作を返せば、コンポーネントはそれらを使って描画できる。

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
- React: useReducer
  https://react.dev/reference/react/useReducer
- React: State as a Snapshot
  https://react.dev/learn/state-as-a-snapshot
- React: You Might Not Need an Effect
  https://react.dev/learn/you-might-not-need-an-effect
- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
