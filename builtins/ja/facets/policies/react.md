# Reactポリシー

React固有の再実行、状態保持、Context、hook、queryの判定を、実際の責務、依存、整合性契約に基づいて行う。

## 原則

| 原則 | 基準 |
|------|------|
| 適用条件を確認 | 元要件、変更契約、実在する影響経路に基づいて適用する |
| 事実を根拠にする | コード、契約、証跡で確認できる条件だけを判定する |
| 依存とコード | Effectが読むreactive valueと再実行条件を一致させる |
| cleanup | 接続、購読、timerなどの外部資源を終了経路で解放する |
| 状態所有 | hook、reducer、Context、store、query、formの方式ではなく所有者と操作経路を確認する |
| query整合性 | query key、invalidation、refetch、ページ連続性を実データ契約で確認する |
| 実害の根拠 | 再実行ループ、漏れ、重複、古い表示など観測できる影響を判定する |
| 最小範囲に限定する | 今回の要求と因果関係のある範囲だけを判定する |
| 判定根拠を統一する | 元要件、変更契約、実在する影響経路から導けない例示を判断基準に追加しない |

## Effectと依存

| 基準 | 判定 |
|------|------|
| Effectが読むreactive valueを依存から外し、古い値を使う | REJECT |
| 不安定な関数やContext valueの参照変化だけで初期取得・購読が繰り返される | REJECT |
| 初期表示の一度きりのロードが、再生成される関数参照の変化で再実行される | REJECT |
| Context/Provider由来関数の参照変化だけで、要件外の初期取得や購読が繰り返される | REJECT |
| 初期表示で一覧を一度だけ読むのに、loading state更新で再取得が走る | REJECT |
| 初期表示で一覧を一度だけ読むのに、message表示やdialog開閉で再取得が走る | REJECT |
| lintを満たすためだけに依存を追加し、仕様外の再取得や再接続を起こす | REJECT |
| ひとつのEffectで独立した同期をまとめ、無関係な値の変化で双方を再実行する | REJECT |
| 外部接続、購読、timerのcleanupがなく、再実行やunmountで資源が残る | REJECT |
| reactive valueを読まず、mount時の同期とcleanupが契約に合うEffectを空配列で実装する | OK |
| mount-onlyのEffectがreactive valueを読まず、同期対象とcleanupが契約に合う | OK |
| lint抑制でreactive valueとの不一致を隠し、古い値や再実行漏れを生む | REJECT |
| 再実行が必要なEffectを空配列で固定する | REJECT |

## exhaustive-depsの扱い

依存を変更する場合は、依存配列だけでなくEffectが同期する対象、event handlerへ移すべき処理、独立した処理の分離を確認する。抑制コメントの有無だけで判定しない。

## State、Context、hook

| 基準 | 判定 |
|------|------|
| local useStateが部分木の所有者に閉じ、他の部分木へ不透明な変更を行わない | OK |
| reducer、Context Provider、dispatch、storeで状態と操作入口をまとめる | OK |
| query hook、form hook、bindingが状態と操作を所有し、表示から経路を追跡できる | OK |
| 同じstateful hookを複数箇所で呼び、共有されると誤認して別々の正規状態を作る | REJECT |
| Context、hook、reducerという名称だけで状態所有や操作経路を確認しない | REJECT |
| 標準APIの形式だけを理由にhook、Context、local state、親callbackを禁止する | REJECT |

## custom hookの責務

| 基準 | 判定 |
|------|------|
| `use*`関数がReact hook、Context、query、form、イベント変換を組み合わせ、責務と経路を追跡できる | OK |
| `use*`関数がReact hookや状態・操作契約を使わず、純粋計算だけを包む | 簡素化を検討 |
| statefulなUI制御はcustom hookに、純粋計算は通常の関数へ分ける | OK |
| hookがJSXを返しても、所有者と操作経路が明確 | 返り値の形式だけで拒否する根拠にしない |
| hookが操作の所有者を隠し、返したJSXを含めて不透明または重複した副作用を起こす | REJECT |

## Props型の配置とhookの境界

| 基準 | 判定 |
|------|------|
| 1つのcomponent専用Propsを、理由なく`types`ファイルへ切り出す | 警告 |
| hookからcomponentのProps型をimportするためだけにPropsを別ファイルへ移す | REJECT |
| 複数componentや公開APIが共有するProps/データ契約を別ファイルへ置く | OK |
| hookは状態・イベント・派生値を返し、containerがcomponent propsへ束ねる | OK |
| hookがcomponent propsを返す場合でも、componentへの型依存をhookに持ち込まない | OK |

## Query、キャッシュ、ページング

| 基準 | 判定 |
|------|------|
| query keyがresource、URL、filter、利用者などデータを識別する条件を欠き、別データを共有する | REJECT |
| 更新後にinvalidation、refetch、または契約に沿ったcache更新のいずれもなく、古いデータを正規表示として残す | REJECT |
| cursor/offset一覧の再取得でページ連続性、重複、欠落の契約がない | REJECT |
| query/infinite queryのAPIとサーバー契約に沿ってページを取得・再取得する | OK |
| cursorまたはoffsetという名前だけでquery cacheを禁止する | REJECTの根拠にしない |
| query hookが取得条件、エラー、更新後の整合性をどのownerからも追跡できない形に隠し、別データや誤った表示を生む | REJECT |
| 安定した単一リソースや一覧を、識別条件と更新契約に合うquery cacheで扱う | OK |

## Formsと標準API

| 基準 | 判定 |
|------|------|
| controlled/uncontrolled input、form library、bindingで入力状態の所有者が明確 | OK |
| Context dispatchや親の公開callbackで操作意図を伝える | OK |
| 標準hook、Context、query、formを特定のMVP形式へ変換するだけの変更 | REJECTの根拠にしない |
