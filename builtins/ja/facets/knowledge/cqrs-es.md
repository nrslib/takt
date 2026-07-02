# CQRS+ES知識

## CQRS+ES採用判断

CQRS+ES は、状態変更をドメイン上の出来事として保存し、そこから現在状態やRead Modelを導出する設計である。バックエンド全体やワークフローが CQRS+ES を扱う場合でも、すべての新機能をイベントソーシングで実装する必要はない。

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
| タスク指示書生成時に元タスクへ存在しない CQRS+ES 要件を追加する | REJECT |

CQRS+ES の採用は要件から導く。既存システムが CQRS+ES を含むことは、依存方向や境界をそろえる理由にはなるが、単純な設定テーブルまでイベントソーシング化する理由にはならない。

### 要件変換時の扱い

元タスクやユーザー要求が CRUD 相当の業務要件だけを述べている場合、タスク指示書に「コマンド・イベント・プロジェクション」を新しい要件として追加しない。CQRS+ES が必要か不明な場合は、採用理由を明示するか、未確認事項として残す。

| 元要求 | 指示書への落とし込み |
|--------|--------------------|
| 「施設ごとに許可IPを管理したい」 | CRUDの管理設定として扱う。ドメイン語彙が「追加・削除」だけで業務ルールがない |
| 「注文の承認・取消・返品を管理し、状態に応じて請求や在庫が連動する」 | CQRS+ESの候補。複雑な状態遷移と業務不変条件があり、複数集約が連動する |
| 「保険の契約変更で、変更種別ごとに審査ルールが異なり、過去の査定履歴が将来の判断に影響する」 | CQRS+ESの候補。ビジネスルールが複雑で変化し、履歴そのものが業務判断の入力になる |
| 「誰がいつ変更したかを画面に出したい」 | CRUD + 監査ログで足りるか確認する。変更履歴の表示だけなら監査列で十分 |
| 「通知設定のON/OFFを切り替えたい」 | CRUDの管理設定として扱う。現在値の参照・更新のみ |

CQRS+ES は複雑なビジネスドメイン（金融、保険、医療など、ビジネスルールが複雑で変化するドメイン）でその真価を発揮する。単純な監査要件や技術的な非同期処理は、それだけでは CQRS+ES の十分条件にならない。判断の軸はビジネスロジックの複雑さにある。

## Aggregate設計

Aggregateは判断に必要なフィールドのみ保持する。

Command Model（Aggregate）の役割は「コマンドを受けて判断し、イベントを発行する」こと。クエリ用データはRead Model（Projection）が担当する。

「判断に必要」とは:
- `if`/`require`の条件分岐に使う
- インスタンスメソッドでイベント発行時にフィールド値を参照する

| 基準 | 判定 |
|------|------|
| Aggregateが複数のトランザクション境界を跨ぐ | REJECT |
| Aggregate間の直接参照（ID参照でない） | REJECT |
| Aggregateが100行を超える | 分割を検討 |
| ビジネス不変条件がAggregate外にある | REJECT |
| 判断に使わないフィールドを保持 | REJECT |

良いAggregate:
```kotlin
// 判断に必要なフィールドのみ
data class Order(
    val orderId: String,      // イベント発行時に使用
    val status: OrderStatus   // 状態チェックに使用
) {
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING) { "確定できる状態ではありません" }
        return OrderConfirmedEvent(
            orderId = orderId,
            confirmedBy = confirmedBy,
            confirmedAt = LocalDateTime.now()
        )
    }
}

// 判断に使わないフィールドを保持（NG）
data class Order(
    val orderId: String,
    val customerId: String,     // 判断に未使用
    val shippingAddress: Address, // 判断に未使用
    val status: OrderStatus
)
```

追加操作がないAggregateはIDのみ:
```kotlin
// 作成のみで追加操作がない場合
data class Notification(val notificationId: String) {
    companion object {
        fun create(customerId: String, message: String): NotificationCreatedEvent {
            return NotificationCreatedEvent(
                notificationId = UUID.randomUUID().toString(),
                customerId = customerId,
                message = message
            )
        }
    }
}
```

### Adapterパターン（ドメインとフレームワークの分離）

ドメインモデルにフレームワークのアノテーション（`@Aggregate`, `@CommandHandler`等）を直接付けない。Adapterクラスがフレームワーク統合を担当し、ドメインモデルはビジネスロジックに専念する。

```kotlin
// ドメインモデル: フレームワーク非依存。ビジネスロジックのみ
data class Order(
    val orderId: String,
    val status: OrderStatus = OrderStatus.PENDING
) {
    companion object {
        fun place(orderId: String, customerId: String): OrderPlacedEvent {
            require(customerId.isNotBlank()) { "Customer ID cannot be blank" }
            return OrderPlacedEvent(orderId, customerId)
        }

        fun from(event: OrderPlacedEvent): Order {
            return Order(orderId = event.orderId, status = OrderStatus.PENDING)
        }
    }

    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING) { "確定できる状態ではありません" }
        return OrderConfirmedEvent(orderId, confirmedBy, LocalDateTime.now())
    }

    fun apply(event: OrderEvent): Order = when (event) {
        is OrderPlacedEvent -> from(event)
        is OrderConfirmedEvent -> copy(status = OrderStatus.CONFIRMED)
        is OrderCancelledEvent -> copy(status = OrderStatus.CANCELLED)
    }
}

// Adapter: フレームワーク統合。ドメイン呼び出し → イベント発行の中継
@Aggregate
class OrderAggregateAdapter() {
    private var order: Order? = null

    @AggregateIdentifier
    fun orderId(): String? = order?.orderId

    @CommandHandler
    constructor(command: PlaceOrderCommand) : this() {
        val event = Order.place(command.orderId, command.customerId)
        AggregateLifecycle.apply(event)
    }

    @CommandHandler
    fun handle(command: ConfirmOrderCommand) {
        val event = order!!.confirm(command.confirmedBy)
        AggregateLifecycle.apply(event)
    }

    @EventSourcingHandler
    fun on(event: OrderEvent) {
        this.order = when (event) {
            is OrderPlacedEvent -> Order.from(event)
            else -> order?.apply(event)
        }
    }
}
```

分離の利点:
- ドメインモデル単体でユニットテスト可能（フレームワーク不要）
- フレームワーク移行時にドメインモデルは変更不要
- Adapterはコマンド受信 → ドメイン呼び出し → イベント発行の定型コード

### apply/from パターン（イベント再生）

ドメインモデルが自身の状態をイベントから再構築するパターン。

- `from(event)`: 生成イベントから初期状態を構築するファクトリ
- `apply(event)`: イベントを受けて新しい状態を返す（`copy()` でイミュータブルに更新）
- `when` 式 + sealed interface で全イベント型の網羅性をコンパイラが保証

```kotlin
fun apply(event: OrderEvent): Order = when (event) {
    is OrderPlacedEvent -> from(event)
    is OrderConfirmedEvent -> copy(status = OrderStatus.CONFIRMED)
    is OrderShippedEvent -> copy(status = OrderStatus.SHIPPED)
    // sealed interface なので、イベント型の追加漏れはコンパイルエラーになる
}
```

| 基準 | 判定 |
|------|------|
| apply 内にビジネスロジック（バリデーション等） | REJECT。applyは状態復元のみ |
| apply が副作用を持つ（DB操作、イベント発行等） | REJECT |
| apply が例外をスローする | REJECT。再生時の失敗は許容しない |

## イベント設計

| 基準 | 判定 |
|------|------|
| イベントが過去形でない（Created → Create） | REJECT |
| イベントにロジックが含まれる | REJECT |
| イベントが他Aggregateの内部状態を含む | REJECT |
| イベントのスキーマがバージョン管理されていない | 警告 |
| CRUDスタイルのイベント（Updated, Deleted） | 要検討 |

良いイベント:
```kotlin
// Good: ドメインの意図が明確
OrderPlaced, PaymentReceived, ItemShipped

// Bad: CRUDスタイル
OrderUpdated, OrderDeleted
```

### sealed interface によるイベント型階層

集約のイベントは sealed interface で型階層化する。集約ルートIDを共通フィールドとして強制し、`when` 式の網羅性チェックを有効にする。

```kotlin
sealed interface OrderEvent {
    val orderId: String  // 全イベントに必須
}

data class OrderPlacedEvent(
    override val orderId: String,
    val customerId: String
) : OrderEvent

data class OrderConfirmedEvent(
    override val orderId: String,
    val approvalInfo: ApprovalInfo
) : OrderEvent

data class OrderCancelledEvent(
    override val orderId: String,
    val cancellationInfo: CancellationInfo
) : OrderEvent
```

利点:
- `when (event)` で全イベント型を列挙しないとコンパイルエラー（`apply` メソッドで特に重要）
- 集約ルートIDの存在をコンパイラが保証
- 型ベースのイベントハンドラ分岐が安全

イベント粒度:
- 細かすぎ: `OrderFieldChanged` → ドメインの意図が不明
- 適切: `ShippingAddressChanged` → 意図が明確
- 粗すぎ: `OrderModified` → 何が変わったか不明

## Event Evolution

イベントは永続化済みの契約であり、現在のイベント型を変えた場合でも過去イベントを再生できなければならない。旧イベントの読み替えはイベント本体やドメインロジックではなく、イベントストアから復元する境界の upcaster / migration 層で行う。

| 基準 | 判定 |
|------|------|
| 永続化済みイベントの型・フィールドを変更したのに変換経路がない | REJECT |
| 現行イベント型に旧フィールド名の alias や互換用プロパティを残す | REJECT。履歴互換は upcaster に分離 |
| Aggregate や apply が旧イベント形式を直接解釈する | REJECT。再生前に現行イベントへ変換する |
| イベントに「変更前の値」を互換目的で追加する | REJECT。イベントは発生後の事実を表す |
| upcaster が旧 payload を現行イベントの意味へ変換する | OK |
| 旧 payload から現行イベントへ変換できることをテストしている | OK |

イベント進化で分ける責務:

| 責務 | 置き場所 |
|------|----------|
| 現行イベントの意味とフィールド | イベント型 |
| 旧 payload の読み替え | upcaster / migration 層 |
| イベント再生による状態復元 | Aggregate の `apply` |
| 旧イベントから現行イベントへ変換できることの保証 | upcaster テスト |

```kotlin
// NG - 現行イベント型に旧フィールド互換を混ぜる
data class OrderAssignedEvent(
    val orderId: String,
    @JsonAlias("assigneeId")
    val assigneeIds: List<String>
)

// OK - 現行イベント型は現行契約だけを表す
data class OrderAssignedEvent(
    val orderId: String,
    val assigneeIds: List<String>
)
```

```kotlin
// OK - 旧 payload を upcaster で現行 payload へ変換する
when (eventType) {
    OrderAssignedEvent::class.java.typeName -> {
        event.moveTextFieldToArray("assigneeId", "assigneeIds")
    }
}
```

旧イベント型そのものをアプリケーションコードに残すかどうかは、利用フレームワークと運用方針で決める。一般には「旧型を通常のドメインイベントとして扱う」のではなく、「旧 serialized type と payload を upcaster の入力契約としてテストする」方が、現行モデルを汚さずに済む。

## コマンドハンドラ

| 基準 | 判定 |
|------|------|
| ハンドラがDBを直接操作 | REJECT |
| ハンドラが複数Aggregateを変更 | REJECT |
| コマンドのバリデーションがない | REJECT |
| ハンドラがクエリを実行して判断 | 要検討 |

良いコマンドハンドラ:
```
1. コマンドを受け取る
2. Aggregateをイベントストアから復元
3. Aggregateにコマンドを適用
4. 発行されたイベントを保存
```

### 多層バリデーション

バリデーションは層ごとに役割が異なる。すべてを1箇所に集めない。

| 層 | 責務 | 手段 | 例 |
|----|------|------|-----|
| API層 | 構造的バリデーション | `@NotBlank`, `init` ブロック | 必須項目、型、フォーマット |
| UseCase層 | ビジネスルール検証 | Read Modelへの問い合わせ | 重複チェック、前提条件の存在確認 |
| ドメイン層 | 状態遷移の不変条件 | `require` | 「PENDINGでないと承認できない」 |

### Aggregateの判断境界

Aggregate は、自身のイベント履歴から復元できる状態と、コマンドとして明示された事実だけで判断する。境界由来の入力を解釈・正規化・所有権確認する場所ではない。

Aggregate に入れてよい検証は「イベント再生だけで再現できる状態」に基づくものに限る。それ以外の検証は、コマンド送信前に境界側で解決し、Aggregate には解決済みの事実を渡す。

| 判断対象 | 置き場所 |
|---------|---------|
| 現在状態でその操作が可能か | Aggregate |
| コマンド実行者がAggregate ownerと一致するか | Aggregate |
| HTTP/API入力の形式が正しいか | API層 |
| object key、URL、path などの外部識別子の形式解釈 | UseCase層または境界側Policy/Verifier |
| 外部識別子が現在user/tenantに属するか | UseCase層または境界側Policy/Verifier |
| Read Modelや他Aggregateの状態確認 | UseCase層 |
| 外部サービス上に実体があるか | Application層の外部サービス連携 |

例: アップロード完了コマンドでは、Aggregate は「このセッションのownerと実行者が一致するか」「現在状態で完了可能か」を判断する。保存先object keyの文字列形式や、そのkeyが現在user/tenantの領域かどうかは、コマンド送信前にUseCase層で検証する。

```kotlin
// API層: 構造的バリデーション
data class OrderPostRequest(
    @field:NotBlank val customerId: String,
    @field:NotNull val items: List<OrderItemRequest>
) {
    init {
        require(items.isNotEmpty()) { "注文には1つ以上の商品が必要です" }
    }
}

// UseCase層: ビジネスルール検証（Read Model参照）
@Service
class PlaceOrderUseCase(
    private val commandGateway: CommandGateway,
    private val customerRepository: CustomerRepository,
    private val inventoryRepository: InventoryRepository
) {
    fun execute(input: PlaceOrderInput): Mono<PlaceOrderOutput> {
        return Mono.fromCallable {
            // 顧客の存在確認
            customerRepository.findById(input.customerId)
                ?: throw CustomerNotFoundException("顧客が存在しません")
            // 在庫の事前確認
            validateInventory(input.items)
            // コマンド送信
            val orderId = UUID.randomUUID().toString()
            commandGateway.send<Any>(PlaceOrderCommand(orderId, input.customerId, input.items))
            PlaceOrderOutput(orderId)
        }
    }
}

// ドメイン層: 状態遷移の不変条件
fun confirm(confirmedBy: String): OrderConfirmedEvent {
    require(status == OrderStatus.PENDING) { "確定できる状態ではありません" }
    return OrderConfirmedEvent(orderId, confirmedBy, LocalDateTime.now())
}
```

| 基準 | 判定 |
|------|------|
| ドメイン層のバリデーションがAPI層にある | REJECT。状態遷移ルールはドメインに |
| UseCase層のバリデーションがController内にある | REJECT。UseCase層に分離 |
| API層のバリデーション（@NotBlank等）がドメインにある | REJECT。構造検証はAPI層で |

## UseCase層（オーケストレーション）

Controller と CommandGateway の間にUseCase層を置く。コマンド発行前に複数集約のRead Modelを参照してバリデーションし、必要な前処理を行う。

```
Controller → UseCase → CommandGateway → Aggregate
                ↓
          QueryGateway / Repository（Read Model参照）
```

UseCaseが必要なケース:
- コマンド発行前にRead Modelから他集約の状態を確認する
- 複数のバリデーションを直列に実行する
- コマンド送信後の結果整合性を待機する（リアクティブポーリング）

UseCaseが不要なケース:
- Controllerからコマンドを1つ送るだけで完結する単純な操作
- ControllerからQuery側へ問い合わせてレスポンスへ変換するだけの単純な参照
- 既存リソースの存在確認・スコープ確認後にコマンドを1つ送るだけの操作

| 基準 | 判定 |
|------|------|
| ControllerがRepository直接参照してバリデーション | UseCase層に分離 |
| UseCaseがHTTPリクエスト/レスポンスに依存 | REJECT。UseCaseはプロトコル非依存 |
| UseCaseがAggregate内部状態を直接変更 | REJECT。CommandGateway経由 |
| UseCaseがSubscription Queryで結果を待機 | REJECT。分散環境で動作しない。リアクティブポーリングを使う |
| UseCaseが別の問い合わせ層やコマンド送信への薄い委譲だけで終わる | 削除を検討 |

## プロジェクション設計

| 基準 | 判定 |
|------|------|
| プロジェクションがコマンドを発行 | REJECT |
| プロジェクションがWriteモデルを参照 | REJECT |
| 複数のユースケースを1つのプロジェクションで賄う | 要検討 |
| リビルド不可能な設計 | REJECT |

良いプロジェクション:
- 特定の読み取りユースケースに最適化
- イベントから冪等に再構築可能
- Writeモデルから完全に独立

### Projection と EventHandler（サイドエフェクト）の区別

どちらも `@EventHandler` を使うが、責務が異なる。混同しない。

| 種類 | 責務 | やること | やらないこと |
|------|------|---------|-------------|
| Projection | Read Model 更新 | Entity の保存・更新 | コマンド送信、外部API呼び出し |
| EventHandler | サイドエフェクト | 他集約へのコマンド送信 | Read Model 更新 |

```kotlin
// Projection: Read Model 更新のみ
@Component
class OrderProjection(private val orderRepository: OrderRepository) {
    @EventHandler
    fun on(event: OrderPlacedEvent) {
        val entity = OrderEntity(
            orderId = event.orderId,
            customerId = event.customerId,
            status = OrderStatus.PENDING
        )
        orderRepository.save(entity)
    }

    @EventHandler
    fun on(event: OrderConfirmedEvent) {
        orderRepository.findById(event.orderId).ifPresent { entity ->
            entity.status = OrderStatus.CONFIRMED
            orderRepository.save(entity)
        }
    }
}

// EventHandler: サイドエフェクト（他集約へのコマンド送信）
@Component
class InventoryReleaseHandler(private val commandGateway: CommandGateway) {
    @EventHandler
    fun on(event: OrderCancelledEvent) {
        val command = ReleaseInventoryCommand(
            productId = event.productId,
            quantity = event.quantity
        )
        commandGateway.send<Any>(command)
    }
}
```

| 基準 | 判定 |
|------|------|
| Projection 内で CommandGateway を使用 | REJECT。EventHandler に分離 |
| EventHandler 内で Repository に save | REJECT。Projection に分離 |
| 1クラスに Projection と EventHandler の責務が混在 | REJECT。クラスを分離 |

### 外部処理の起動

外部ワーカーや非同期処理の起動は、Aggregate が確定したドメインイベントを起点にする。Application Service や Coordinator が、コマンド送信と外部副作用を同じ制御フローで束ねない。

| 基準 | 判定 |
|------|------|
| Application Service や Coordinator がコマンド送信直後に同じ状態遷移の外部処理を起動する | REJECT。確定済みイベントの EventHandler に分離 |
| Aggregate が生成開始・処理開始を表すイベントを発行し、EventHandler が外部処理を起動する | OK |
| 外部処理の起動失敗を EventHandler が失敗コマンドとして Aggregate に戻す | OK |
| 外部処理に必要な入力がイベントまたは安定したIDから再取得できるデータで表現されている | OK |
| 外部処理の入力がコマンド処理中のローカル変数にしか存在しない | REJECT。イベントまたは再取得可能な参照へ移す |
| 競合や補償を持たない単純な外部処理起動に Saga を使う | REJECT。EventHandler で十分 |

## Query側の設計

Query側はイベント駆動のPubSubモデルで動作する。Projection が EventHandler でRead Modelを更新し、Query側はRead Modelを参照する。

イベント配信はPubSub（メッセージブローカー経由）で全インスタンスに配信する。同一インスタンスへの配信を前提とする仕組みは使わない。

- **Subscription Query**（たとえばAxonの `subscriptionQuery()`）: クエリ結果の変更通知を購読元インスタンスに返す仕組みだが、分散配置やサードパーティのイベントストアプラグイン使用時に、購読を発行したインスタンスと通知を受け取るインスタンスが異なり、同一筐体でレスポンスを返せない。同期的な応答が必要な場合はリアクティブポーリングで Read Model の更新を待機する。
- **Subscribing イベントプロセッサ**（たとえばAxonの `SubscribingEventProcessor`）: ローカルのイベントバスからの直接購読に依存し、イベントを発行したインスタンスのみがイベントを受け取る。分散環境では他インスタンスの Projection が更新されない。PubSubで全インスタンスにイベントが配信される構成にする。

| 基準 | 判定 |
|------|------|
| Subscription Query（たとえばAxonの `subscriptionQuery()`）の使用 | REJECT。分散環境で動作しない。リアクティブポーリングを使う |
| Subscribing イベントプロセッサ（たとえばAxonの `SubscribingEventProcessor`）の使用 | REJECT。ローカル配信のみ。分散環境で他インスタンスが更新されない |
| Controller から Repository を直接参照 | REJECT。UseCase層を経由 |
| Query側が Command Model を参照 | REJECT |
| QueryHandler がコマンドを発行 | REJECT |
| Query側のサービスやハンドラが保存・削除・外部API呼び出しを行う | REJECT |
| Command と Query を同じサービスに混在させる | REJECT。責務と命名を分離 |
| Query側で存在確認やスコープ確認を行い、呼び出し元がコマンドを送る | OK |

### QueryHandler と ApplicationService の命名

CQRSではクエリを受けるコンポーネントを QueryHandler と呼び、クエリを送る入口は QueryGateway / QueryBus として扱う。Controller から読み取りユースケースを呼ぶ facade は、QueryHandler と混同しないよう ApplicationService または ReadService と名付ける。

| 基準 | 判定 |
|------|------|
| Query を受けて Read Model を参照し、Query結果の型を返す | QueryHandler |
| Controller から複数Query、認可境界、ページング、DTO組み立てを調整する | ApplicationService または ReadService |
| Query送信や読み取り調整だけのクラスを QueryService と呼ぶ | 警告。QueryHandler と混同しやすい |
| QueryHandler がHTTPリクエスト/レスポンスやController都合のエラー変換を知る | REJECT |
| 追加判断のない単純な読み取り wrapper を作る | 削除を検討。Controller から QueryGateway 直でもよい |

レイヤー間の型:
- `application/query/` - Query結果の型（例: `OrderDetail`）
- `adapter/protocol/` - RESTレスポンスの型（例: `OrderDetailResponse`）
- QueryHandler は application層の型を返し、Controller が adapter層の型に変換

```kotlin
// application/query/OrderDetail.kt
data class OrderDetail(
    val orderId: String,
    val customerName: String,
    val totalAmount: Money
)

// adapter/protocol/OrderDetailResponse.kt
data class OrderDetailResponse(...) {
    companion object {
        fun from(detail: OrderDetail) = OrderDetailResponse(...)
    }
}

// QueryHandler - application層の型を返す
@QueryHandler
fun handle(query: GetOrderDetailQuery): OrderDetail? {
    val entity = repository.findById(query.id) ?: return null
    return OrderDetail(...)
}

// Controller - 単純な参照は同期返却で十分
@GetMapping("/{id}")
fun getById(@PathVariable id: String): ResponseEntity<OrderDetailResponse> {
    val detail = queryGateway.query(
        GetOrderDetailQuery(id),
        OrderDetail::class.java
    ).join() ?: throw NotFoundException("...")

    return ResponseEntity.ok(OrderDetailResponse.from(detail))
}
```

構成:
```
Controller (adapter) → QueryGateway → QueryHandler (application) → Repository
     ↓                                      ↓
Response.from(detail)                  OrderDetail

イベント流（PubSub）:
Aggregate → Event Bus → Projection(@EventHandler) → Repository(Read Model)
                                                          ↑
                                          QueryHandler がここを参照
```

### 非同期コールバックと並行制御

非同期処理の完了通知は重複・遅延・順序逆転を前提に設計する。Controller や単一プロセス内のロックではなく、Aggregate の状態遷移とコマンドの冪等性で守る。

| 基準 | 判定 |
|------|------|
| Controllerやアプリケーションプロセス内のロックで重複callbackを防ぐ | REJECT。複数インスタンスで効かない |
| 処理中かどうかをAggregate状態で判断する | OK |
| callbackの試行IDや世代をAggregateが検証する | OK |
| 古いcallbackや重複callbackを状態遷移で冪等に無視する | OK |
| 並行制御がController、UseCase、Aggregateに重複して散らばる | REJECT |

## 結果整合性

コマンド発行後に同期的なレスポンスが必要な場合、リアクティブポーリングで Projection の更新を待機する。

| 基準 | 判定 |
|------|------|
| Subscription Query で Projection 更新を待機 | REJECT。分散環境で動作しない。リアクティブポーリングを使う |
| `Thread.sleep` や同等の待機でリクエストスレッドをブロックして Projection 更新を待つ | REJECT。高並行時にスレッド枯渇を起こす |
| 同一HTTPレスポンスで更新後状態を返す必要がある | リアクティブHTTPスタックで非ブロッキングに待機 |
| 同一HTTPレスポンスで待つ必要がない | `202 Accepted` + フロントエンドのロングポーリング、通常ポーリング、SSE、WebSocket |
| UIが即座に更新を期待している | フロントエンドポーリング、SSE、WebSocket、またはサーバー側のリアクティブ待機 |
| 整合性遅延が許容範囲を超える | アーキテクチャ再検討 |
| 補償トランザクションが未定義 | 障害シナリオの検討を要求 |

### リアクティブポーリング

コマンド発行 → Projection更新完了を非ブロッキングなポーリングで待機するパターン。リアクティブポーリングはリクエストスレッドを占有しない待機であり、`while` ループと `Thread.sleep` で同期的に待つ実装ではない。

```kotlin
// UseCase: コマンド送信 → ポーリングで完了待機
fun execute(input: PlaceOrderInput): Mono<PlaceOrderOutput> {
    val orderId = UUID.randomUUID().toString()
    return Mono.fromCallable { validatePreConditions(input) }
        .subscribeOn(Schedulers.boundedElastic())
        .flatMap {
            Mono.fromFuture(commandGateway.send<Any>(
                PlaceOrderCommand(orderId, input.customerId, input.items)
            ))
        }
        .then(pollForCompletion(orderId))
        .thenReturn(PlaceOrderOutput(orderId))
}

// ポーリング: Projection の更新を待機
private fun pollForCompletion(orderId: String): Mono<Void> {
    return ReactivePolling.waitFor(
        supplier = { orderRepository.findById(orderId).orElse(null) },
        condition = { it.sagaCompleted || it.status == OrderStatus.CONFIRMED },
        timeout = Duration.ofSeconds(60),
        maxAttempts = 300
    )
}
```

ブロッキング待機は避ける:

```kotlin
// NG - リクエストスレッドを占有し、負荷時にスレッド枯渇を起こす
while (Instant.now().isBefore(deadline)) {
    val order = orderRepository.findById(orderId).orElse(null)
    if (order?.status == OrderStatus.CONFIRMED) return PlaceOrderOutput(orderId)
    Thread.sleep(100)
}

// OK - 同一レスポンスで待つならリアクティブな待機へ載せる
return pollForCompletion(orderId).thenReturn(PlaceOrderOutput(orderId))
```

ポーリングが適切なケース:
- Saga が完了するまでレスポンスを返したくない場合
- コマンド発行後に作成されたリソースのIDを返す場合

ポーリングが不要なケース:
- コマンド発行だけで完了する単純な操作（結果を待たない）
- UIがリアルタイム更新を必要としない場合

サーバー側で待たない場合は、コマンド受付後に `202 Accepted` と追跡IDを返し、フロントエンドが読み取りAPIをロングポーリングまたは通常ポーリングする。ユーザー体験上の即時性が必要なら SSE や WebSocket も選択肢に含める。

## Saga vs EventHandler

Sagaは「競合が発生する複数アグリゲート間の操作」にのみ使用する。

Sagaが必要なケース:
```
複数のアクターが同じリソースを取り合う場合
例: 在庫確保（10人が同時に同じ商品を注文）

OrderPlacedEvent
  ↓ InventoryReservationSaga
ReserveInventoryCommand → Inventory集約（同時実行を直列化）
  ↓
InventoryReservedEvent → ConfirmOrderCommand
InventoryReservationFailedEvent → CancelOrderCommand
```

Sagaが不要なケース:
```
競合が発生しない操作
例: 注文キャンセル時の在庫解放

OrderCancelledEvent
  ↓ InventoryReleaseHandler（単純なEventHandler）
ReleaseInventoryCommand
  ↓
InventoryReleasedEvent
```

判断基準:

| 状況 | Saga | EventHandler |
|------|------|--------------|
| リソースの取り合いがある | 使う | - |
| 補償トランザクションが必要 | 使う | - |
| 競合しない単純な連携 | - | 使う |
| 失敗時は再試行で十分 | - | 使う |

アンチパターン:
```kotlin
// NG - ライフサイクル管理のためにSagaを使う
@Saga
class OrderLifecycleSaga {
    // 注文の全状態遷移をSagaで追跡
    // PLACED → CONFIRMED → SHIPPED → DELIVERED
}

// OK - 結果整合性が必要な操作だけをSagaで処理
@Saga
class InventoryReservationSaga {
    // 在庫確保の同時実行制御のみ
}
```

Sagaはライフサイクル管理ツールではない。結果整合性が必要な「操作」単位で作成する。

## 例外 vs イベント（失敗時の選択）

監査不要な失敗は例外、監査が必要な失敗はイベント。

例外アプローチ（推奨: ほとんどのケース）:
```kotlin
// ドメインモデル: バリデーション失敗時に例外をスロー
fun reserveInventory(orderId: String, quantity: Int): InventoryReservedEvent {
    if (availableQuantity < quantity) {
        throw InsufficientInventoryException("在庫が不足しています")
    }
    return InventoryReservedEvent(productId, orderId, quantity)
}

// Saga: exceptionally でキャッチして補償アクション
commandGateway.send<Any>(command)
    .exceptionally { ex ->
        commandGateway.send<Any>(CancelOrderCommand(
            orderId = orderId,
            reason = ex.cause?.message ?: "在庫確保に失敗しました"
        ))
        null
    }
```

イベントアプローチ（稀なケース）:
```kotlin
// 監査が必要な場合のみ
data class PaymentFailedEvent(
    val paymentId: String,
    val reason: String,
    val attemptedAmount: Money
) : PaymentEvent
```

判断基準:

| 質問 | 例外 | イベント |
|------|------|----------|
| この失敗を後で確認する必要があるか? | No | Yes |
| 規制やコンプライアンスで記録が必要か? | No | Yes |
| Sagaだけが失敗を気にするか? | Yes | No |
| Event Storeに残すと価値があるか? | No | Yes |

デフォルトは例外アプローチ。監査要件がある場合のみイベントを検討する。

## 抽象化レベルの評価

**条件分岐の肥大化検出**

| パターン | 判定 |
|---------|------|
| 同じif-elseパターンが3箇所以上 | ポリモーフィズムで抽象化 → REJECT |
| switch/caseが5分岐以上 | Strategy/Mapパターンを検討 |
| イベント種別による分岐が増殖 | イベントハンドラを分離 → REJECT |
| Aggregate内の状態分岐が複雑 | State Patternを検討 |

**抽象度の不一致検出**

| パターン | 問題 | 修正案 |
|---------|------|--------|
| CommandHandlerにDB操作詳細 | 責務違反 | Repository層に分離 |
| EventHandlerにビジネスロジック | 責務違反 | ドメインサービスに抽出 |
| Aggregateに永続化処理 | レイヤー違反 | EventStore経由に変更 |
| Projectionに計算ロジック | 保守困難 | 専用サービスに抽出 |

良い抽象化の例:

```kotlin
// イベント種別による分岐の増殖（NG）
@EventHandler
fun on(event: DomainEvent) {
    when (event) {
        is OrderPlacedEvent -> handleOrderPlaced(event)
        is OrderConfirmedEvent -> handleOrderConfirmed(event)
        is OrderShippedEvent -> handleOrderShipped(event)
        // ...どんどん増える
    }
}

// イベントごとにハンドラを分離（OK）
@EventHandler
fun on(event: OrderPlacedEvent) { ... }

@EventHandler
fun on(event: OrderConfirmedEvent) { ... }

@EventHandler
fun on(event: OrderShippedEvent) { ... }
```

```kotlin
// 状態による分岐が複雑（NG）
fun process(command: ProcessCommand) {
    when (status) {
        PENDING -> if (command.type == "approve") { ... } else if (command.type == "reject") { ... }
        APPROVED -> if (command.type == "ship") { ... }
        // ...複雑化
    }
}

// State Patternで抽象化（OK）
sealed class OrderState {
    abstract fun handle(command: ProcessCommand): List<DomainEvent>
}
class PendingState : OrderState() {
    override fun handle(command: ProcessCommand) = when (command) {
        is ApproveCommand -> listOf(OrderApprovedEvent(...))
        is RejectCommand -> listOf(OrderRejectedEvent(...))
        else -> throw InvalidCommandException()
    }
}
```

## アンチパターン検出

以下を見つけたら REJECT:

| アンチパターン | 問題 |
|---------------|------|
| CRUD偽装 | CQRSの形だけ真似てCRUD実装 |
| Anemic Domain Model | Aggregateが単なるデータ構造 |
| Event Soup | 意味のないイベントが乱発される |
| Temporal Coupling | イベント順序に暗黙の依存 |
| Missing Events | 重要なドメインイベントが欠落 |
| God Aggregate | 1つのAggregateに全責務が集中 |

## テスト戦略

レイヤーごとにテスト方針を分ける。

テストピラミッド:
```
        ┌─────────────┐
        │   E2E Test  │  ← 少数: 全体フロー確認
        ├─────────────┤
        │ Integration │  ← Command→Event→Projection→Query の連携確認
        ├─────────────┤
        │  Unit Test  │  ← 多数: 各レイヤー独立テスト
        └─────────────┘
```

Command側（Aggregate）:
```kotlin
// AggregateTestFixture使用
@Test
fun `確定コマンドでイベントが発行される`() {
    fixture
        .given(OrderPlacedEvent(...))
        .`when`(ConfirmOrderCommand(orderId, confirmedBy))
        .expectSuccessfulHandlerExecution()
        .expectEvents(OrderConfirmedEvent(...))
}
```

Query側:
```kotlin
// Read Model直接セットアップ + QueryGateway
@Test
fun `注文詳細が取得できる`() {
    // Given: Read Modelを直接セットアップ
    orderRepository.save(OrderEntity(...))

    // When: QueryGateway経由でクエリ実行
    val detail = queryGateway.query(GetOrderDetailQuery(orderId), ...).join()

    // Then
    assertEquals(expectedDetail, detail)
}
```

チェック項目:

| 観点 | 判定 |
|------|------|
| Aggregateテストが状態ではなくイベントを検証している | 必須 |
| Query側テストがCommand経由でデータを作っていない | 推奨 |
| 統合テストでAxonの非同期処理を考慮している | 必須 |

## 値オブジェクト設計

Aggregate とイベントの構成要素として値オブジェクトを使う。プリミティブ型（String, Int）で済ませない。

```kotlin
// NG - プリミティブ型のまま
data class OrderPlacedEvent(
    val orderId: String,
    val categoryId: String,      // ただの文字列
    val from: LocalDateTime,     // 意味が不明確
    val to: LocalDateTime
)

// OK - 値オブジェクトで意味と制約を表現
data class OrderPlacedEvent(
    val orderId: String,
    val categoryId: CategoryId,
    val period: OrderPeriod
)
```

値オブジェクトの設計ルール:
- `data class` で equals/hashCode を自動生成（同値性で比較）
- `init` ブロックで不変条件を保証（生成時に必ず検証）
- ドメインロジック（計算）は含まない（純粋なデータホルダー）
- `@JsonValue` でシリアライゼーションを制御

```kotlin
// ID系: 単一値ラッパー
data class CategoryId(@get:JsonValue val value: String) {
    init {
        require(value.isNotBlank()) { "Category ID cannot be blank" }
    }
    override fun toString(): String = value
}

// 範囲系: 複数値の不変条件を保証
data class OrderPeriod(
    val from: LocalDateTime,
    val to: LocalDateTime
) {
    init {
        require(!to.isBefore(from)) { "終了日は開始日以降でなければなりません" }
    }
}

// メタ情報系: イベントペイロード内の付随情報
data class ApprovalInfo(
    val approvedBy: String,
    val approvalTime: LocalDateTime
)
```

| 基準 | 判定 |
|------|------|
| IDをStringのまま使い回す | 値オブジェクト化を検討 |
| 同じフィールドの組み合わせ（from/to等）が複数箇所に | 値オブジェクトに抽出 |
| 値オブジェクトにビジネスロジック（状態遷移等） | REJECT。Aggregateの責務 |
| init ブロックなしで不変条件が保証されない | REJECT |

## マスタデータ・設定値と CRUD の使い分け

CQRS+ES システム内でも、すべてをイベントソーシングで実装する必要はない。マスタデータ（参照データ）、管理設定、許可リストのように性質が単純なものは、通常の CRUD で実装した方がシンプルで保守しやすい。

ただし、「マスタデータだから CRUD」と機械的に判断しない。以下の基準で該当するものが多いほど CRUD が適している。逆に、CQRS+ES 採用判断の基準に該当する明示要件があれば、採用を検討する。

**CRUD で十分と判断する基準:**

| 観点 | CRUD 寄り | CQRS+ES 寄り |
|------|----------|-------------|
| ビジネス要件 | 「〜を管理したい」程度で特別な言及がない | 固有のビジネスルールや制約がある |
| ロジックの発展 | 単純な参照・更新で完結し、発展が見込めない | 状態遷移やライフサイクルが複雑化しうる |
| 変更履歴・監査 | 「いつ誰が変えたか」の追跡が不要 | 変更履歴の参照や監査証跡が必要 |
| ドメインイベント | この変更が他の集約やプロセスに影響しない | 変更が下流プロセスをトリガーする |
| 整合性の範囲 | 単体で完結し、他集約との整合性が不要 | 他の集約と整合性を保つ必要がある |
| 時点参照 | 「過去のある時点の状態」を問われない | 時点指定のクエリが必要 |

**典型的な CRUD 対象の例:**
- 都道府県・国コードなどのコードマスタ
- カテゴリ・タグなどの分類マスタ
- 設定値・定数テーブル
- IP許可リスト、機能フラグ、通知設定などの現在値ベースの管理設定

**CQRS+ES が必要と判断できる例:**
- 商品マスタだが、価格変更履歴の追跡が必要
- 組織マスタだが、変更時に権限の再計算をトリガーする
- 取引先マスタだが、与信審査の状態遷移がある

```kotlin
// CRUD で十分: 単純なカテゴリマスタ
@Entity
data class Category(
    @Id val categoryId: String,
    val name: String,
    val displayOrder: Int
)

// CQRS+ES が適切: 価格変更履歴の追跡が必要な商品
data class Product(
    val productId: String,
    val currentPrice: Money
) {
    fun changePrice(newPrice: Money, reason: String): PriceChangedEvent {
        require(newPrice.amount > BigDecimal.ZERO) { "価格は正の値でなければなりません" }
        return PriceChangedEvent(productId, currentPrice, newPrice, reason)
    }
}
```

CRUD で実装する場合も、CQRS+ES システム内の他集約からは ID 参照で利用する。CRUD エンティティが集約の内部状態を直接参照しない点は同じ。

## インフラ層

確認事項:
- イベントストアの選択は適切か
- メッセージング基盤は要件を満たすか
- スナップショット戦略は定義されているか
- イベントのシリアライズ形式は適切か
