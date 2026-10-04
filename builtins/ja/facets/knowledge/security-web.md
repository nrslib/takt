# ブラウザ境界のセキュリティ知識

## 適用条件

低信頼の値が HTML、JavaScript、CSS、URL、DOM、browser storage、またはブラウザが解釈・送信する request へ到達する変更に適用する。静的な表示変更や内部表現だけではこの境界を示さない。

## ブラウザの解釈 semantics

browser semantics によって、値が text のままか、実行可能 content になるか、origin・遷移先を変えるか、credential とともに送信されるかが決まる。validation・sanitize 関数の名前だけでは最終的な browser context を立証できない。

| 条件 | 確認するブラウザ境界・影響 |
|------|------------------------------|
| 低信頼の値が HTML・script・style・DOM sink へ到達する | 最終的な parse context と、被害者 origin で実行・再解釈されるかを確認する |
| framework rendering で text・属性へ値が到達する | その context における既定 escape の semantics を確認し、URL の挙動は別に評価する |
| 値が URL・redirect・frame・resource を選ぶ | 許可 scheme・origin・宛先と、credential・保護 data が request に伴うかを確認する |
| 値が保存され、後で表示される | 保存 source から後続 renderer、browser sink、影響を受ける観測者まで追跡する |

到達可能な source-to-sink 経路が明確なら、既知の browser parsing・request 挙動によって、payload を実行せずに実行・credential 影響を立証できる。

## Origin と credential 付き request

CORS はブラウザが response を読める origin を制御するが、server 側の認可を確立しない。状態変更 request では、cookie などが自動送信されるか、どの origin が request を開始できるか、server が独立して認証・認可・scope を適用するかを確認する。

## Browser から受け取るファイル

ファイル名、Content-Type、拡張子は低信頼の metadata である。保存先、公開方法、後続 parser・renderer を追跡し、高信頼の origin・service による実行、上書き、保護 data access、別形式としての再解釈を影響として確認する。
