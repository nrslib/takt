# Reactポリシー

Reactのstate、props、Context、reducer、Effect、hookの設計を、再実行、状態の寿命、操作経路、外部システムとの同期から判定する。

## 原則

| 原則 | 基準 |
|------|------|
| stateの所有 | 一つの事実を一つの担当で保持し、表示と操作の経路を追える |
| props | 親からの入力とcomponent内部の編集状態の寿命を区別する |
| Context | 深いcomponentへ値と操作を配る経路として使い、値を作る担当を明示する |
| reducer | 現在stateと操作意図から副作用なしに次stateを計算する |
| Effect | render外のシステムとの同期に使い、依存とcleanupを同期対象に合わせる |
| hook | statefulな責務をまとめ、画面の動作と表示部品の依存方向を追える形にする |
| Reactの実行規則 | Hook、render、props、keyの規則を状態の寿命と再実行の根拠として確認する |
| 根拠 | React APIの形式ではなく、再実行、漏れ、重複、古い表示、責務混在を判定する |

## State、Props、派生値

| 基準 | 判定 |
|------|------|
| 兄弟componentが共有するstateをそれぞれの `useState` で保持し、表示や操作がずれる | REJECT |
| propsの変更が必要なcomponentで、初期値をstateへコピーしたまま古い値を表示する | REJECT |
| stateから計算できる一覧、件数、全選択、ラベルを別stateとしてEffectで同期する | REJECT |
| stateを最小共通のcomponentへ置き、propsと操作入口から表示へ流す | OK |
| controlled input、localな編集草稿、componentのidentity変更など、状態の寿命を実際の要件に合わせる | OK |
| memo化が計算量や参照安定性の実在する問題を解決せず、依存と変更経路を隠す | REJECT |

stateの配置は、共有範囲、寿命、更新操作、表示への反映から決める。

## Context、Reducer、操作入口

| 基準 | 判定 |
|------|------|
| Contextの値から、`useState` または `useReducer` を呼ぶProvider・componentと操作経路が追える | OK |
| Contextへ画面固有の通信と複数の正規stateを詰め、どの操作がどのstateを変えるか読めない | REJECT |
| reducerが副作用を実行し、通信・timer・通知の結果をstate変更と区別できない | REJECT |
| reducerが現在stateとeventから副作用なしに次stateを返し、副作用はhandlerやEffectなどの担当へ置く | OK |
| 複数のbutton、form、keyboard操作が同じcommandへ入り、現在stateで受理・拒否される | OK |
| clickとsubmitなど複数入口が同じ通信を直接呼び、二重送信を生む | REJECT |

Contextは値を配る仕組みである。`useState` や `useReducer` を呼ぶProvider・component、query、formなどが、どの部分木の状態と操作を担当するかを確認する。

## Effectと依存

| 基準 | 判定 |
|------|------|
| Effectが読むreactive valueを依存に含めず、古い値で同期する | REJECT |
| Effectの依存が、実際に再接続・再取得したい条件と一致しない | REJECT |
| callbackやContext valueの参照変化だけで、機能上不要な再取得・再接続が実際に繰り返される | REJECT |
| 一つのEffectに独立した同期をまとめ、無関係な値で双方が再実行される | REJECT |
| 接続、購読、timer、取得の再実行時とunmount時にcleanupがなく、古い資源や結果が残る | REJECT |
| Effectが読む値と同期対象を整理した上で、依存を明示し、cleanupを返す | OK |
| mount時だけの同期がreactive valueを読まず、その開始・停止の契約と一致する | OK |

依存配列をlintの警告だけで変更せず、値をEffectの外へ出す、操作handlerへ移す、同期を分けるなど責務を先に整理する。再実行が必要なEffectを空配列で固定しない。

## Reactの実行規則

| 基準 | 判定 |
|------|------|
| Hookをcomponentまたはcustom hookのトップレベル以外で呼び、renderごとの呼び出し順が変わる | REJECT |
| render中に通信、通知、DOM操作、外部変数の変更などの副作用を実行する | REJECT |
| props、state、またはそれらのネストした値を直接変更する | REJECT |
| 並び替え可能な一覧でindexをkeyにし、行の入れ替え後に入力や選択のstateが別項目へ移る | REJECT |
| 安定した項目の識別子をkeyに使い、componentの位置とstateの寿命を意図に合わせる | OK |

## Custom Hookとcomponent境界

| 基準 | 判定 |
|------|------|
| hookがReactのstate、Effect、Context、query、form、event変換を一つの責務としてまとめる | OK |
| hookが純粋計算だけを包み、statefulな契約を持たない | 通常の関数との分割を検討する |
| hook、component、画面の依存方向が循環し、どの変更が表示・通信へ届くか読めない | REJECT |
| hookが返すstate、event、派生値をcomponentの描画パラメータへ束ねる経路が明確 | OK |

React componentがlocal stateやevent handlerを持つことと、厳密なPassive Viewが同一であることは別に扱う。画面・領域の裁定が必要な箇所では、componentの描画部分へ通信や遷移の判断を混ぜず、Reactの慣用的なhook、reducer、handlerで担当を分ける。
