# API・サーバーセキュリティ知識

## 適用条件

低信頼のrequestがserver側の認証、認可、resource選択、interpreter、外部接続、または永続化へ到達する変更に適用する。endpointが存在するだけ、または内部実装だけを変えて信頼境界が変わらない場合には適用しない。

## 入力からinterpreterへの境界

SQL、template、query language、expression、server-side requestなど、入力を別の言語や宛先として解釈する境界を追跡する。API名や「validation済み」という名称だけではなく、dataと命令・宛先が分離されていることを確認する。

| 基準 | 判定 |
|------|------|
| 低信頼の値をqueryやtemplateの命令部分へ連結する | REJECT |
| 低信頼のURL・hostが内部networkやcredential付きrequestの宛先を選べる | REJECT |
| parameter bindingや構造化builderでdataと命令を分離する | OK |
| 外部接続先をscheme・host・redirectを含めて必要な範囲へ制約する | OK |

## 認証・認可・resource scope

認証は呼び出し主体を確立し、認可はその主体が操作できるactionとresourceを制約する。routeに認可middlewareがあるかだけでなく、取得・更新・削除の全経路で同じresource scopeが適用されることを確認する。

| 基準 | 判定 |
|------|------|
| privateまたは所有領域付きresourceをrequest由来のIDだけで取得し、主体との関係を検証しない | REJECT |
| 保護対象の読込にはscopeを適用するが、対応する更新・削除には適用しない | REJECT |
| client指定のowner・tenant・roleを、独立した認可なしに認証済み主体より優先する | REJECT |
| 認証済み主体からactionとresource scopeを解決し、全操作へ一貫して適用する | OK |

## 入出力契約とresource消費

型・形式・列挙値・長さ・件数は、後段が依存する契約に合わせて境界で制約する。ただし、validationやrate limitがないという一般論だけでは問題にせず、低信頼の入力から権限逸脱、解釈境界、または現実的なresource枯渇へ至る経路を示す。

responseとerrorには、呼び出し元へ返す必要のないcredential、内部path、query、stack、他resourceの内容を含めない。

## 所有領域の分離

複数のowner、tenant、workspace、accountなどを扱う場合、認可（誰が操作できるか）とscope（どの所有領域か）を別々に確立し、組み合わせて問い合わせる。

| 基準 | 判定 |
|------|------|
| 読み取りは所有領域でscopeされるが、書き込みはscopeされない | REJECT |
| client指定の所有領域を認証済み主体との照合なしに使う | REJECT |
| roleやtoken種別ごとの分岐に、scopeが確立されない経路がある | REJECT |
| 認証済み主体からscopeを解決し、読み書きのqueryへ同じ制約を適用する | OK |
