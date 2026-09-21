# Reactポリシー

Reactのstate、props、Context、reducer、Effect、hookを、再描画、stateの寿命、操作の経路、外部システムとの同期から判定する。

## State、Props、派生値

| 基準 | 判定 |
|------|------|
| 兄弟コンポーネントが共有するstateをそれぞれの`useState`で持ち、表示や操作がずれる | REJECT |
| propsの変更が必要なコンポーネントで、初期値をstateへコピーしたまま古い値を表示する | REJECT |
| stateから計算できる一覧、件数、全選択、ラベルを別stateとしてEffectで同期する | REJECT |
| 共通の親がstateを一つ持ち、propsと操作のcallbackを子へ渡す | OK |
| controlled input、編集草稿、`key`による作り直しを、必要なstateの寿命に合わせて選ぶ | OK |
| 実際の計算量や参照の問題を解決せず、memo化で依存と更新経路を隠す | REJECT |

## Context、Reducer、操作

| 基準 | 判定 |
|------|------|
| Providerやコンポーネントが`useState`・`useReducer`・queryなどで値を作り、Contextがその値と操作を配る | OK |
| reducerが通信、timer、通知などの副作用を実行する | REJECT |
| reducerがstateとeventから次のstateを返し、通信はハンドラ、結果の反映はdispatchで行う | OK |
| form、button、keyboardなど複数の入口が同じハンドラへ入り、現在stateで受理・拒否される | OK |
| clickとsubmitなど複数の入口が同じ通信を直接呼び、二重送信を起こす | REJECT |

## Effectと依存

| 基準 | 判定 |
|------|------|
| Effectが読むreactive valueを依存に含めず、古い値で同期する | REJECT |
| 依存が再接続・再取得したい条件と一致しない | REJECT |
| callbackやContext valueの参照が変わるだけで、機能上不要な再取得・再接続が実際に繰り返される | REJECT |
| 一つのEffectに別々の同期をまとめ、無関係な値で双方が再実行される | REJECT |
| 接続、購読、timer、取得の再実行前とunmount時にcleanupがなく、古い資源や結果が残る | REJECT |
| 同期対象と再実行条件を決め、依存を明示してcleanupを返す | OK |

依存配列をlintの警告だけで変更しない。値をEffectの外へ出す、操作ハンドラへ移す、同期を分けるなど、同期対象を先に整理する。

## Reactの実行規則

| 基準 | 判定 |
|------|------|
| Hookをコンポーネントまたはcustom hookのトップレベル以外で呼び、呼出し順が描画ごとに変わる | REJECT |
| 描画中に通信、通知、DOM操作、外部変数の変更などの副作用を行う | REJECT |
| props、state、その内部の値を直接変更する | REJECT |
| 並べ替え可能な一覧でindexを`key`にし、行の入れ替え後に入力や選択のstateが別項目へ移る | REJECT |
| 項目の安定した識別子を`key`に使い、コンポーネントの位置とstateの寿命を意図に合わせる | OK |

## Custom Hook

| 基準 | 判定 |
|------|------|
| hookがstate、Effect、Context、query、form、イベント変換を一つの画面の動作としてまとめる | OK |
| hookが純粋な計算だけを包む | 通常の関数との分割を検討する |
| hook、コンポーネント、画面が循環依存し、表示や通信の変更経路が読めない | REJECT |
| hookが返すstate、event、派生値を描画の入力へ渡す経路が分かる | OK |

hook内部の`useState`は呼出しごとに別のstateを作る。Context、query、外部storeを読むhookは共有元の値を返せるため、実際に何を読み書きするかで判定する。
