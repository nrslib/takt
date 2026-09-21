{extends:gui}

# フロントエンドポリシー

Web画面の到達経路、表示契約、データ取得、アクセシビリティ、安全性を、GUIの責務境界と実在する影響経路に基づいて判定する。

## 原則

| 原則 | 基準 |
|------|------|
| 適用条件を確認 | 元要件、変更契約、実在する影響経路に基づいて適用する |
| 事実を根拠にする | コード、契約、証跡で確認できる条件だけを判定する |
| 責務境界を守る | 判定対象の所有者と観測可能な影響を分けて確認する |
| Web境界を確認 | route、URL、DOM、browser、API、serverの境界を実際の入口と出口で確認する |
| 表示契約を守る | accessible name、role、state、表示単位、文言の意味と自然さを確認する |
| データ境界を守る | APIクライアント、取得スコープ、キャッシュ、再取得条件を実際の契約で確認する |
| 最小範囲に限定する | 今回の要求と因果関係のある範囲だけを判定する |
| 判定根拠を統一する | 元要件、変更契約、実在する影響経路から導けない例示を判断基準に追加しない |

## 画面追加時のルーティング配線

| 基準 | 判定 |
|------|------|
| 新規ページを作成したのにRouterへrouteがない | REJECT |
| basename配下のURLとroute pathの対応を確認していない | REJECT |
| 画面、Root階層、担当所有者、Router、実際の入口を同じ変更契約として確認している | OK |
| 開発用の一時導線を使う場合、その理由と後で除去する前提を記録している | OK |
| routeを更新したが、メニュー、ボタン、リンク、外部呼び出しなど実際の入口を未確認 | 警告 |

## 外部UIライブラリとの統合

| 基準 | 判定 |
|------|------|
| 主要UIライブラリのpropsを、既存プロジェクトのバージョン確認なしに推測で渡す | REJECT |
| テストでライブラリ本体を完全にモックし、実マウント時の破綻を見逃す | 警告 |
| 代表的なpropsで実コンポーネントを描画し、画面レベルでクラッシュしないことを確認する | OK |
| 既存画面の利用パターンやプロジェクト依存バージョンを参照してprops形を決める | OK |

## アクセシビリティ契約

| 基準 | 判定 |
|------|------|
| 新しい操作要素にaccessible nameがない | REJECT |
| チェック状態、展開状態、無効状態などの状態が支援技術へ公開されていない | 警告 |
| 既存のaccessible nameを要求外で変更する | REJECT |
| 動的なaccessible nameを断片の連結だけで組み立て、最終的な文の意味・自然さを確認していない | REJECT |
| 同一の操作コンテキストにある別要素が、名前またはプログラム上の文脈（行・グループとの関連付け等）で識別できない | REJECT。対象名をaccessible nameに含めるのは識別の有力な手段 |
| 既存のaccessible nameを保ち、不足していたrole/stateを追加する | OK |
| 既存契約を変更する理由と影響範囲が明示されている | OK |

## 状態と派生値

| 基準 | 判定 |
|------|------|
| 不要なグローバル状態を導入している | ローカル化を検討 |
| 同じ正規状態を複数の所有者が管理し、実際の不整合が生じる | REJECT。整合性を担う部分木または共有ownerへ正規化 |
| APIレスポンスを正規状態へ入れる前の意味・識別子・表示契約が確認されていない | 正規化を検討 |
| あるstateから常に計算できる値を別stateとして保持している | REJECT |
| 複数state間の不変条件をeffectや手動同期で保っている | REJECT |
| 表示ラベル、件数、合計、全選択状態、並び替え結果、グルーピング結果を正規stateとして保持している | REJECT |
| API送信、保存、差分判定が正規stateではなく派生stateに依存している | REJECT |
| フィルタ・ページング・グルーピング後の表示位置を元データの順序番号として扱っている | REJECT。どの集合の順序かを定義し、その集合から導出する |
| 正規stateだけを保持し、表示・集計・判定をselector、render、memoなどで導出している | OK |
| 外部契約で必要な派生値を、送信・保存の境界で正規stateから生成している | OK |

## APIクライアントとデータ取得

| 基準 | 判定 |
|------|------|
| 生成ツールが存在するのにaxiosInstanceやfetchを直接使用する | REJECT |
| 生成ツールの設定や既存の取得口を確認せずAPI hookを手書きする | REJECT |
| 生成ツールが存在しないプロジェクトで、担当ownerまたは通信境界から直接呼び出す | OK |
| Viewがquery hookやdata-fetching hookを呼び、hookまたはProviderが状態・通信・エラーを所有する | OK |
| 表示専用Viewが取得条件、状態更新、通信エラーの裁定まで直接所有する | REJECT |
| ローディング、エラー、キャンセルを未処理のまま表示へ流す | REJECT |
| N+1クエリ的なフェッチを導入する | REJECT |

取得をRootだけへ固定しない。route、画面owner、独立widgetなど、必要なデータと整合性を担当する部分木のownerが取得してよい。取得結果の公開境界と操作経路が追跡できることを確認する。

## 初期表示と再取得

| 基準 | 判定 |
|------|------|
| 初期取得がProvider/Contextの関数参照変化だけで再実行される | REJECT |
| 再取得条件がURL、filter、paging、明示的な更新操作、またはquery/library/serverの契約として定義されている | OK |
| message表示、loading切替、dialog開閉だけで無関係な再取得が起きる | REJECT |
| 初期取得をmount-onlyとする契約があり、以後の再取得が明示トリガーまたは契約されたquery条件で行われる | OK |
| 初期取得と後続の再取得を別のイベント・遷移として扱っている | OK |
| reactive valueを参照する処理の依存を、lint都合だけで省略または追加している | REJECT |

## キャッシュとページング

cursorやoffsetという名前だけでキャッシュの可否を決めない。query key、無効化、refetch、ページの連続性、重複・欠落、表示中のスナップショットをサーバーとライブラリの契約で確認する。

| 基準 | 判定 |
|------|------|
| query keyがURL、filter、paging、利用者・tenantなどデータの識別条件を欠き、別データを共有する | REJECT |
| 更新後のinvalidation、refetch、または契約に沿ったcache更新がなく、古い表示を正規データとして扱う | REJECT |
| cursor/offset一覧の再取得でページ整合性、重複、欠落を確認していない | REJECT |
| ライブラリのquery/infinite query契約に沿ってページを取得・再取得する | OK |
| cursor/offsetを使っているという形式だけでquery cacheを禁止する | REJECTの根拠にしない |

## 独立widgetと通信スコープ

| 基準 | 判定 |
|------|------|
| 親からURL、id、filterなどを公開入力として受け、query identity（query keyや依存値）と無効化・refetchなどの更新契約が入力に対応し、親の正規状態を二重所有せず自身のownerを持つwidget | OK |
| 親のURL、id、filter、権限、状態を暗黙に読む通信をwidgetへ隠す、または同じ正規状態を契約なく別query/stateとして二重所有する | REJECT |
| 表示中のtabやscreenに必要な通信を、その部分木のownerが行う | OK |
| 全tab共通の親で全画面の通信をまとめ、非表示tabへ配る | REJECT |
| 非表示tabでもポーリングや購読が継続する | REJECT |

## 画面専用APIの利用

| 基準 | 判定 |
|------|------|
| 一覧APIのレスポンスを詳細画面の正規データとして使い回す | REJECT |
| 一覧の表示単位とAPIの取得単位がずれている | REJECT |
| 判定だけのために全件取得する（集計APIを使うべき） | REJECT |
| UIが必要とする概念が応答に存在せず、意味の異なる本文・説明フィールドを暗黙に見出しへ流用している | REJECT。表示契約として要約・fallbackを定義するか、専用fieldを用意する |
| 画面ごとに専用の取得口を持ち、必要なデータだけ返す | OK |

## 表示形式とWeb境界

| 基準 | 判定 |
|------|------|
| backendが表示用文字列を返し、localeや文脈を失わせている | 設計見直しを提案 |
| 同じformat処理が複数箇所にコピペされている | utility関数に統一 |
| コンポーネント内でinline formatを行っている | 関数に抽出 |
| コンポーネント内のformatが表示契約と異なる値を操作や保存へ流用する | REJECT |
| route、URL、DOM、browser API、server APIの境界で入力と出力の契約を確認している | OK |

## フロントエンドとバックエンドの責務分離

| 基準 | 判定 |
|------|------|
| フロントエンドで価格計算・在庫判定・業務上のstatus遷移を確定する | REJECT。backendを正本にする |
| フロントエンドだけで業務バリデーションを完了させる | REJECT |
| server側で計算可能な値をfrontendで再計算する | 冗長。REJECT |
| serverが返した表示状態をformatし、UI操作をcommandとして送る | OK |
| UI専用の必須入力、表示filter、previewなどをclientで扱い、serverでも必要な検証を行う | OK |

## パフォーマンス、型、安全性、テスト

| 基準 | 判定 |
|------|------|
| 不要な再レンダリング | 最適化が必要 |
| 大きなlistのvirtualizeなし | 警告 |
| 画像の最適化なし | 警告 |
| bundleに未使用コードがある | tree-shakingを確認 |
| memo化を過剰に使用する | 本当に必要か確認 |
| any型を使用する | REJECT |
| 型アサーション（as）を契約確認なしに乱用する | 要検討 |
| Props型定義がない | REJECT |
| event handlerの型が不適切 | 修正が必要 |
| interactive要素にkeyboard対応がない | REJECT |
| 画像にalt属性がない | REJECT |
| form要素にlabelがない | REJECT |
| 色だけで情報を伝える | REJECT |
| modalなどでfocus管理を欠く | REJECT |
| dangerouslySetInnerHTMLを使い、XSSリスクを確認していない | XSSリスクを確認 |
| ユーザー入力を未sanitizeのままDOMへ流す | REJECT |
| 機密情報をfrontendへ保存する | REJECT |
| CSRF tokenを必要とする境界で未使用 | 要確認 |
| data-testid等がなく、今回の変更で検証可能性を落としている | 警告 |
| テスト困難な構造で、責務経路を確認できない | 分離を検討 |
| ビジネスロジックをUIへ埋め込む | REJECT |
| stateと操作の経路をView描画だけでテストし、実マウントやAPI境界を確認しない | 警告 |

## ネイティブイベントとアプリ操作

| 基準 | 判定 |
|------|------|
| DOMのcapture/bubble、既定動作、アプリのcallbackが同じ操作を二度実行する | REJECT |
| すべてのDOMイベントでstopPropagationを呼ばないことだけを理由に実装を拒否する | REJECTの根拠にしない |
| ネイティブイベントの伝播と状態ownerへ届けるアプリ操作意図を区別する | OK |

## アンチパターン検出

| パターン | 判定 |
|---------|------|
| God Component | REJECT。無関係な機能や副作用を一つのcomponentへ集中し、所有者と変更影響を追跡できない |
| Prop Drilling | REJECT。深いpropsバケツリレーで所有者や操作の意味が隠れる場合。意味を変えずにcallbackやpropsを委譲するだけなら深さだけで拒否しない |
| Inline Stylesの乱用 | REJECT。保守性とテーマ契約を損なう |
| useEffect地獄 | REJECT。依存関係が複雑すぎるeffectを積み重ねる |
| Premature Optimization | REJECT。必要性のないmemo化を追加する |
| Magic Strings | REJECT。意味のある文字列をハードコードする |
| Hidden Dependencies | REJECT。子componentが隠れたAPI呼び出しを持つ |
| Over-generalization | REJECT。要求のない汎用化を強制する |
