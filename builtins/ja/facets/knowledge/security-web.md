# ブラウザ境界のセキュリティ知識

## 適用条件

低信頼の値がブラウザで解釈されるHTML、JavaScript、CSS、URL、DOM、またはブラウザから送信されるrequestへ到達する変更に適用する。静的な表示変更や、信頼境界を跨がない内部表現の変更には適用しない。

## ブラウザの解釈境界

値を検証したかどうかではなく、最終的にどの文脈でブラウザが解釈するかを確認する。HTML、属性、script、style、URLでは必要な防御が異なる。

| 基準 | 判定 |
|------|------|
| 低信頼の値が実行可能なHTMLまたはscript sinkへ未処理で到達する | REJECT |
| 低信頼の値が危険なURL scheme、open redirect、またはcredential送信先を選べる | REJECT |
| text・属性の文脈に合うframeworkの既定エスケープを保ち、URLは別途許可条件を検証する | OK |
| 値の使用文脈に対応したencode・sanitize・allowlistを境界で行う | OK |

## Originとrequest

CORSはブラウザがresponseを読めるoriginを制御する仕組みであり、認証・認可の代替ではない。cookieなどブラウザが自動送信するcredentialを使う更新requestでは、意図しないoriginから操作を起動できないことも確認する。

| 基準 | 判定 |
|------|------|
| CORSの許可をserver側の認可として扱う | REJECT |
| credential付きrequestを任意originから起動でき、状態変更に到達する | REJECT |
| 許可originを運用上必要な範囲へ制約し、server側でも認可する | OK |

## Browserから受け取るファイル

ファイル名、Content-Type、拡張子は低信頼のmetadataとして扱う。保存先、公開方法、後続のparserやrendererまで追跡し、実行・上書き・別形式としての再解釈へ到達する具体的な経路がある場合にだけ問題とする。
