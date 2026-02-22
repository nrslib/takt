# CQRS+ES知識

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
- コマンド送信後の結果整合性を待機する（ポーリング等）

UseCaseが不要なケース:
- Controllerからコマンドを1つ送るだけで完結する単純な操作

| 基準 | 判定 |
|------|------|
| ControllerがRepository直接参照してバリデーション | UseCase層に分離 |
| UseCaseがHTTPリクエスト/レスポンスに依存 | REJECT。UseCaseはプロトコル非依存 |
| UseCaseがAggregate内部状態を直接変更 | REJECT。CommandGateway経由 |

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

## Query側の設計

ControllerはQueryGatewayを使う。Repositoryを直接使わない。

レイヤー間の型:
- `application/query/` - Query結果の型（例: `OrderDetail`）
- `adapter/protocol/` - RESTレスポンスの型（例: `OrderDetailResponse`）
- QueryHandlerはapplication層の型を返し、Controllerがadapter層の型に変換

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

// Controller - adapter層の型に変換
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
```

## 結果整合性

| 状況 | 対応 |
|------|------|
| UIが即座に更新を期待している | 設計見直し or ポーリング/WebSocket |
| 整合性遅延が許容範囲を超える | アーキテクチャ再検討 |
| 補償トランザクションが未定義 | 障害シナリオの検討を要求 |

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

## インフラ層

確認事項:
- イベントストアの選択は適切か
- メッセージング基盤は要件を満たすか
- スナップショット戦略は定義されているか
- イベントのシリアライズ形式は適切か
