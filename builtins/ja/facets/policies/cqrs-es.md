# CQRS+ESポリシー

CQRS+ES の採用、境界、状態遷移、イベント連鎖に関する独立した判定を一つの正本で行う。

## 原則

| 原則 | 基準 |
|------|------|
| 要件から採用を判断 | 元要件・設計資料・既存境界にない CQRS+ES 要件を追加しない |
| Aggregate の責務を限定 | 状態遷移と不変条件を Aggregate に置き、Read Model や別 Aggregate の内部状態を持ち込まない |
| イベントを事実として扱う | 発生した業務上の事実を過去形で記録し、`Create` や `OpenAccount` のような動詞原形・命令形をイベント名にしない。技術的な処理起動の重複イベントも作らない |
| イベント再生を純粋に保つ | `apply` は状態復元だけを行い、バリデーション・例外・副作用を持たせない |
| Command の意図を保つ | Read Model の現在値で command 種別を選ばず、復元済み Aggregate に判断させる |
| 連鎖をイベントから始める | 同じ状態遷移の command を直列送信せず、確定済みイベントから EventHandler を起動する |
| Read/Write の境界を守る | Projection は Read Model を更新し、Query 側から command や Write Model を扱わない |
| 副作用の所有者を分ける | Projection、EventHandler、外部処理の責務を混在させない |

## CQRS+ES採用判断

| 基準 | 判定 |
|------|------|
| ユーザー要求・設計資料・既存境界が CQRS+ES を明示している | CQRS+ES を採用 |
| 状態遷移、ライフサイクル、業務上の不変条件が機能の中心 | CQRS+ES を検討 |
| 変更イベントが他集約・Saga・下流プロセスを起動する | CQRS+ES を検討 |
| 過去時点の状態復元、イベント再生、監査証跡そのものが要件 | CQRS+ES を検討 |
| 読み取りモデルを複数用途へ非同期投影する必要がある | CQRS+ES を検討 |
| 現在値の参照・更新だけで完結する管理設定 | CRUD を優先 |
| セキュリティ設定、機能フラグ、許可リスト、閾値などの即時反映が重要 | CRUD を優先 |
| 「作成・更新・削除したい」以上のドメイン語彙がない | CRUD を優先 |
| CQRS+ESワークフローで実装しているだけ | 採用根拠にしない |
| 元要件に存在しない CQRS+ES 要件を追加する | REJECT |

## Aggregate設計

| 基準 | 判定 |
|------|------|
| Aggregateが複数のトランザクション境界を跨ぐ | REJECT |
| Aggregate間の直接参照（ID参照でない） | REJECT |
| ビジネス不変条件がAggregate外にある | REJECT |
| 判断に使わないフィールドを保持 | REJECT |
| `source` / `input` / `origin` / `channel` / `type` などの由来メタデータで状態遷移を分岐 | 原則REJECT |
| 既存Aggregateの通常ライフサイクルで許可される状態を、特定入力元だけ拒否 | REJECT |
| 作成時の呼び出し者を Aggregate 状態に保持し、後続イベントのアクターとして流用 | REJECT。各コマンドで実行者を渡す |

| 基準 | 判定 |
|------|------|
| 由来メタデータが表示・検索・監査・連携追跡だけに必要 | Event payload または Read Model に保持 |
| 由来メタデータを使った分岐が既存Aggregateの通常ライフサイクルと異なる制約を作る | REJECT |
| 特定入力元だけ、通常は任意の項目を必須化する | REJECT |
| 入力元ごとに本当に不変条件が異なる | 別Aggregate / 別Command / 別UseCase境界を検討 |
| `require` のためだけに由来メタデータを Aggregate state へ追加する | REJECT |

| 基準 | 判定 |
|------|------|
| 既存 Aggregate の通常 command / event で同じ事実を表せる | 既存ライフサイクルを使う |
| 入力元別の wrapper が通常 command を薄く委譲しているだけ | REJECT |
| 入力元別の command が通常ライフサイクルより強い必須条件を追加する | REJECT |
| 既存 Aggregate の削除・更新イベントから派生処理を起動できる | EventHandler に分離 |
| 専用フローだけが必要な表示・検索項目 | Read Model に保持 |
| 入力元ごとに本当に状態遷移や不変条件が異なる | 別 Aggregate / 別 bounded context を検討 |

## イベント再生

| 基準 | 判定 |
|------|------|
| `apply` 内にビジネスロジック（バリデーション等） | REJECT。applyは状態復元のみ |
| `apply` が副作用を持つ（DB操作、イベント発行等） | REJECT |
| `apply` が例外をスローする | REJECT。再生時の失敗は許容しない |

## イベント設計

| 基準 | 判定 |
|------|------|
| イベントが過去形でない（Created → Create） | REJECT |
| イベントにロジックが含まれる | REJECT |
| イベントが他Aggregateの内部状態を含む | REJECT |
| イベントのスキーマがバージョン管理されていない | 警告 |
| CRUDスタイルのイベント（Updated, Deleted） | 要検討 |

| 基準 | 判定 |
|------|------|
| 接尾辞または現在の消費者数だけでイベント／コマンドを判定する | REJECT。業務上の意味とライフサイクルで判断する |
| 同じ業務上の事実を、状態用（Linked 等）と処理起動用（Requested 等）に重複分割する | REJECT。発行元集約が所有する事実へ統合する |
| 外部サービス・別コンテキストへの非同期依頼で、受理・待機が業務上の事実となり、完了/失敗を追跡する | OK。要求を受理した事実として表現できる |
| 確定・承認などの既存事実イベントで表せる処理起動に、専用の要求イベントを追加する | REJECT。既存の事実を EventHandler（必要ならドメインポリシー）が購読する |
| 他集約の状態だけが変わる出来事を、自分のストリームのイベントとして記録する | REJECT。事実はそれが起きた集約自身のストリームに積む |
| 自分の状態やライフサイクルに関与しない操作を集約に経由させ、中継イベントで対象集約へ転送する | REJECT。対象集約へコマンドを送り、所属・存在確認は不変条件の所有境界で行う |

## コマンドハンドラ

| 基準 | 判定 |
|------|------|
| ハンドラがDBを直接操作 | REJECT |
| ハンドラが複数Aggregateを変更 | REJECT |
| コマンドのバリデーションがない | REJECT |
| ハンドラがクエリを実行して判断 | 要検討 |
| 操作が生み得るイベント数と戻り値の契約が一致しない | 要検討。単一・任意・複数・結果型のどれを使うかは、ドメイン上の多重度と言語・フレームワークの規約で決める |

| 基準 | 判定 |
|------|------|
| ドメインモデルが配送・フレームワーク固有のコマンド型を直接受け取る | REJECT。application / adapter 境界でドメインの入力へ変換する |
| domain 層から参照されない application メッセージを domain パッケージに置く | application 境界へ移す |
| コマンドの移動・改名 | 予約・outbox・再試行・dead-letter・監査等の永続参照を影響対象として確認する |

## Command の意図と検証境界

| 基準 | 判定 |
|------|------|
| 他Aggregateや外部事実の存在・scopeを事前確認して、解決済み事実を command に渡す | OK |
| 同じ Aggregate の Read Model を読んで command 種別を選ぶ | REJECT |
| 「存在すれば update、なければ add」を UseCase が Query 結果で決める | REJECT。Set / Attach / Upsert などの意図 command を Aggregate に送る |
| Aggregate または AggregateAdapter が復元済み状態で既存有無・遷移可否を判断する | OK |
| Aggregate が冪等に無視できる重複 command を EventHandler や UseCase が事前 Query で抑止する | REJECT。Aggregate の状態遷移で守る |
| ドメイン層のバリデーションがAPI層にある | REJECT。状態遷移ルールはドメインに |
| UseCase層のバリデーションがController内にある | REJECT。UseCase層に分離 |
| API層のバリデーション（@NotBlank等）がドメインにある | REJECT。構造検証はAPI層で |

## UseCase とイベント連鎖

| 基準 | 判定 |
|------|------|
| ControllerがRepository直接参照してバリデーション | UseCase層に分離 |
| UseCaseがHTTPリクエスト/レスポンスに依存 | REJECT。UseCaseはプロトコル非依存 |
| UseCaseがAggregate内部状態を直接変更 | REJECT。CommandGateway経由 |
| UseCaseが同じ状態遷移のために複数 command を順番に送る | REJECT。確定済みイベントの EventHandler に分離 |
| UseCaseが同じ Aggregate の状態を Query して command 種別を投げ分ける | REJECT。Aggregate に判断を寄せる |
| UseCaseが他Aggregateや外部事実を検証し、解決済み事実を1つの command に渡す | OK |
| 確定済みイベントを EventHandler が受け、他Aggregateへの command を送る | OK |
| processStore / ProcessStore / operationProcess / completeStep で投影完了や手順進行を保存する | REJECT。Projection と EventHandler で表現 |
| 明示的な長期業務プロセス、再試行、補償、利用者に見える進捗がある | Saga / Process Manager を検討 |
| UseCaseが別の問い合わせ層やコマンド送信への薄い委譲だけで終わる | 削除を検討 |

| 基準 | 判定 |
|------|------|
| UseCase が command A の直後に同じ状態遷移の command B を送る | REJECT。A のイベントを EventHandler が受けて B を送る |
| `sendAndWait` の戻り後に別 command を送って整合性を作る | REJECT。イベント連鎖に分離 |
| 既存 Aggregate の通常イベントが派生処理の起点になる | OK |
| EventHandler が確定済みイベントを受け、冪等な command を別Aggregateへ送る | OK |
| Projection 更新と次の command 送信を同じ handler に混ぜる | REJECT。Projection と EventHandler を分離 |
| 競合、補償、長期 retry、利用者に見える進捗がある | Saga / Process Manager を検討 |
| 単に「途中状態を覚えたい」だけで processStore を作る | REJECT。Aggregate event / Projection / Saga の責務に分ける |

## Projection と外部処理

| 基準 | 判定 |
|------|------|
| プロジェクションがコマンドを発行 | REJECT |
| プロジェクションがWriteモデルを参照 | REJECT |
| 複数のユースケースを1つのプロジェクションで賄う | 要検討 |
| リビルド不可能な設計 | REJECT |
| Projection 内で CommandGateway を使用 | REJECT。EventHandler に分離 |
| EventHandler 内で Repository に save | REJECT。Projection に分離 |
| 1クラスに Projection と EventHandler の責務が混在 | REJECT。クラスを分離 |
| Application Service や Coordinator がコマンド送信直後に同じ状態遷移の外部処理を起動する | REJECT。確定済みイベントの EventHandler に分離 |
| Aggregate が生成開始・処理開始を表すイベントを発行し、EventHandler が外部処理を起動する | OK |
| 外部処理の起動失敗を EventHandler が失敗コマンドとして Aggregate に戻す | OK |
| 外部処理に必要な入力がイベントまたは安定したIDから再取得できるデータで表現されている | OK |
| 外部処理の入力がコマンド処理中のローカル変数にしか存在しない | REJECT。イベントまたは再取得可能な参照へ移す |
| 競合や補償を持たない単純な外部処理起動に Saga を使う | REJECT。EventHandler で十分 |

## Query側と並行制御

| 基準 | 判定 |
|------|------|
| 既存基盤として配送保証が確認できる Subscription Query の使用 | OK |
| 機能実装のためだけに Subscription Query を新規導入する | REJECT。既存の tracker / Read Model polling を使う |
| 配送保証が確認できない Subscription Query の使用 | REJECT。既存の tracker / Read Model polling を使う |
| Subscribing イベントプロセッサの使用 | REJECT。ローカル配信のみ。分散環境で他インスタンスが更新されない |
| Controller から Repository を直接参照 | REJECT。UseCase層を経由 |
| Query側が Command Model を参照 | REJECT |
| QueryHandler がコマンドを発行 | REJECT |
| Query側のサービスやハンドラが保存・削除・外部API呼び出しを行う | REJECT |
| Command と Query を同じサービスに混在させる | REJECT。責務と命名を分離 |
| Query側やReadServiceがQuery結果を見て同一Aggregateへの command 種別を決める | REJECT |
| Query側で他Aggregateや外部事実の存在確認・スコープ確認を行い、呼び出し元が1つの command を送る | OK |
| Query を受けて Read Model を参照し、Query結果の型を返す | QueryHandler |
| Controller から複数Query、認可境界、ページング、DTO組み立てを調整する | ApplicationService または ReadService |
| Query送信や読み取り調整だけのクラスを QueryService と呼ぶ | 警告。QueryHandler と混同しやすい |
| QueryHandler がHTTPリクエスト/レスポンスやController都合のエラー変換を知る | REJECT |
| 追加判断のない単純な読み取り wrapper を作る | 削除を検討。Controller から QueryGateway 直でもよい |
| Controllerやアプリケーションプロセス内のロックで重複callbackを防ぐ | REJECT。複数インスタンスで効かない |
| 処理中かどうかをAggregate状態で判断する | OK |
| callbackの試行IDや世代をAggregateが検証する | OK |
| 古いcallbackや重複callbackを状態遷移で冪等に無視する | OK |
| 並行制御がController、UseCase、Aggregateに重複して散らばる | REJECT |

## 結果整合性

| 基準 | 判定 |
|------|------|
| 同一レスポンスで更新後 Read Model を返す明示契約がない | 待機しない |
| 画面側や呼び出し元が command の入力値・生成IDを保持できる | 待機しない |
| 待機中の処理へ Projection 更新通知が確実に配送される基盤がある | OK。通知駆動で待機してよい |
| 既存基盤として Subscription Query など、購読元へ更新通知が届く構成が確認できている | OK |
| Kafka などを使い、通知の配送先と再配送・欠落時の扱いが運用上保証されている | OK |
| Subscription Query やイベント通知の配送先が単一プロセス・単一インスタンス前提、または保証不明 | REJECT。既存の tracker / Read Model polling を使う |
| `Thread.sleep` や同等の待機でリクエストスレッドをブロックして Projection 更新を待つ | REJECT。高並行時にスレッド枯渇を起こす |
| `delayedExecutor` / `CompletableFuture` で Projection 待機の retry を独自実装する | REJECT。リアクティブHTTPスタックや既存 tracker を使う |
| processStore / ProcessStore / materialStore / completeStep で Projection 反映状況を管理する | REJECT。Projection はイベントから冪等に更新する |
| 同一HTTPレスポンスで更新後状態を返す必要がある | リアクティブHTTPスタックで非ブロッキングに待機 |
| 同一HTTPレスポンスで待つ必要がない | `202 Accepted` + フロントエンドのロングポーリング、通常ポーリング、SSE、WebSocket |
| UIが即座に更新を期待している | フロントエンドポーリング、SSE、WebSocket。サーバー側待機は同期 API 契約がある場合のみ |
| 整合性遅延が許容範囲を超える | アーキテクチャ再検討 |
| 補償トランザクションが未定義 | 障害シナリオの検討を要求 |

## テストと値オブジェクト

| 基準 | 判定 |
|------|------|
| Aggregateテストが状態ではなくイベントを検証している | 必須 |
| Query側テストがCommand経由でデータを作っていない | 推奨 |
| 統合テストでAxonの非同期処理を考慮している | 必須 |
| IDをStringのまま使い回す | 値オブジェクト化を検討 |
| 同じフィールドの組み合わせ（from/to等）が複数箇所に | 値オブジェクトに抽出 |
| 値オブジェクトにビジネスロジック（状態遷移等） | REJECT。Aggregateの責務 |
| init ブロックなしで不変条件が保証されない | REJECT |

## アンチパターン

| 基準 | 判定 |
|------|------|
| CRUD偽装（CQRSの形だけ真似てCRUD実装） | REJECT |
| Anemic Domain Model（Aggregateが単なるデータ構造） | REJECT |
| Event Soup（意味のないイベントが乱発される） | REJECT |
| Temporal Coupling（イベント順序に暗黙の依存） | REJECT |
| Missing Events（重要なドメインイベントが欠落） | REJECT |
| God Aggregate（1つのAggregateに全責務が集中） | REJECT |

## テストの最低基準

| 基準 | 判定 |
|------|------|
| Aggregateテストが状態ではなくイベントを検証している | 必須 |
| Query側テストがCommand経由でデータを作っていない | 推奨 |
| 統合テストでAxonの非同期処理を考慮している | 必須 |
