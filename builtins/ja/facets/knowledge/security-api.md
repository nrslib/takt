# API・サーバーセキュリティ知識

## 適用条件

低信頼の request が server 側の認証、認可、resource 選択、interpreter、外部接続、永続化へ到達する変更に適用する。endpoint の存在だけでは境界変更を示さない。

## 入力から interpreter・宛先への境界

SQL、template、query language、expression、外部接続先は server 権限で値を解釈する。どの部分が data のままで、どの部分が命令または宛先になり得るかを追跡する。

| 条件 | 確認する境界・影響 |
|------|--------------------|
| request の値を query や template の命令部分へ連結する | request source から interpreter と、その権限で可能な database・service 操作まで追う |
| request の URL・host が外部接続先を選ぶ | 到達可能な scheme・host・redirect・内部 target・付随 credential を特定する |
| parameter binding または構造化 builder を使う | interpreter 境界で値が data のまま分離されることを確認する |
| 宛先を制約する | scheme・host・redirect・credential が要求範囲に留まることを確認する |

request 入力から連結または resource 選択を経て interpreter と保護資産へ至る連鎖は、静的なコード経路で立証できる。コードと既知の interpreter 挙動で各 link と具体的影響を示せる場合、成功した攻撃 PoC は必須ではない。

## 認証・認可・resource scope

認証は caller、認可は許可 action、resource scope は操作可能な owner・tenant・workspace・account を確立する。route middleware の存在だけでは resource scope を立証できない。

| 条件 | 確認する境界・影響 |
|------|--------------------|
| request 指定 ID で保護 resource を取得・変更する | 認証済み caller から導いた所有 scope も操作へ適用されるか確認する |
| 読み取りには scope があるが対応する更新・削除にはない | caller が別の所有領域を変更できるか追跡する |
| client 指定の owner・tenant・role が caller identity を上書きする | override を許可する独立した認可の有無を確認する |
| 認証済み caller から scope を解決する | 同じ制約が関連する全ての read・write へ到達するか確認する |

## 入出力契約と resource 消費

型・形式・列挙値・長さ・件数は、後段の契約が依存する場合に判断材料になる。validation や rate limit の欠如は、権限逸脱、解釈、保護された出力、現実的な resource 枯渇への経路と結び付く場合にだけセキュリティ上の証拠になる。response・error では、credential、内部情報、他 resource の内容を受け取れる caller または観測者を特定する。
