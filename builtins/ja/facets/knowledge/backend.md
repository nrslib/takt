# バックエンド専門知識

## ヘキサゴナルアーキテクチャ（ポートとアダプター）

依存方向は外側から内側へ。逆方向の依存は禁止。

```
adapter（外部） → application（ユースケース） → domain（ビジネスロジック）
```

ディレクトリ構成:

```
{domain-name}/
├── domain/                  # ドメイン層（フレームワーク非依存）
│   ├── model/
│   │   └── aggregate/       # 集約ルート、値オブジェクト
│   └── service/             # ドメインサービス
├── application/             # アプリケーション層（ユースケース）
│   ├── usecase/             # オーケストレーション
│   └── query/               # クエリハンドラ
├── adapter/                 # アダプター層（外部接続）
│   ├── inbound/             # 入力アダプター
│   │   └── rest/            # REST Controller, Request/Response DTO
│   └── outbound/            # 出力アダプター
│       └── persistence/     # Entity, Repository実装
└── api/                     # 公開インターフェース（他ドメインから参照可能）
    └── events/              # ドメインイベント
```

各層の責務:

| 層 | 責務 | 依存してよいもの | 依存してはいけないもの |
|----|------|----------------|---------------------|
| domain | ビジネスロジック、不変条件 | 標準ライブラリのみ | フレームワーク、DB、外部API |
| application | ユースケースのオーケストレーション | domain | adapter の具体実装 |
| adapter/inbound | HTTPリクエスト受信、DTO変換 | application, domain | outbound adapter |
| adapter/outbound | DB永続化、外部API呼び出し | domain（インターフェース） | application |

```kotlin
// CORRECT - ドメイン層はフレームワーク非依存
data class Order(val orderId: String, val status: OrderStatus) {
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING)
        return OrderConfirmedEvent(orderId, confirmedBy)
    }
}

// WRONG - ドメイン層にSpringアノテーション
@Entity
data class Order(
    @Id val orderId: String,
    @Enumerated(EnumType.STRING) val status: OrderStatus
) {
    fun confirm(confirmedBy: String) { ... }
}
```

| 基準 | 判定 |
|------|------|
| ドメイン層にフレームワーク依存（@Entity, @Component等） | REJECT |
| Controller から Repository を直接参照 | REJECT。UseCase層を経由 |
| ドメイン層から外向きの依存（DB, HTTP等） | REJECT |
| adapter 間の直接依存（inbound → outbound） | REJECT |

## API層設計（Controller）

Controller は薄く保つ。リクエスト受信 → UseCase委譲 → レスポンス返却のみ。

```kotlin
// CORRECT - Controller は薄い
@RestController
@RequestMapping("/api/orders")
class OrdersController(
    private val placeOrderUseCase: PlaceOrderUseCase,
    private val queryGateway: QueryGateway
) {
    // Command: 状態変更
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun post(@Valid @RequestBody request: OrderPostRequest): OrderPostResponse {
        val output = placeOrderUseCase.execute(request.toInput())
        return OrderPostResponse(output.orderId)
    }

    // Query: 参照
    @GetMapping("/{id}")
    fun get(@PathVariable id: String): ResponseEntity<OrderGetResponse> {
        val detail = queryGateway.query(FindOrderQuery(id), OrderDetail::class.java).join()
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(OrderGetResponse.from(detail))
    }
}

// WRONG - Controller にビジネスロジック
@PostMapping
fun post(@RequestBody request: OrderPostRequest): ResponseEntity<Any> {
    // バリデーション、在庫チェック、計算... Controller に書いてはいけない
    val stock = inventoryRepository.findByProductId(request.productId)
    if (stock.quantity < request.quantity) {
        return ResponseEntity.badRequest().body("在庫不足")
    }
    val total = request.quantity * request.unitPrice * 1.1  // 税計算
    orderRepository.save(OrderEntity(...))
    return ResponseEntity.ok(...)
}
```

### Request/Response DTO 設計

Request と Response は別の型として定義する。ドメインモデルをそのままAPIに露出しない。

```kotlin
// Request: バリデーションアノテーション + init ブロック
data class OrderPostRequest(
    @field:NotBlank val customerId: String,
    @field:NotNull val items: List<OrderItemRequest>
) {
    init {
        require(items.isNotEmpty()) { "注文には1つ以上の商品が必要です" }
    }

    fun toInput() = PlaceOrderInput(customerId = customerId, items = items.map { it.toItem() })
}

// Response: ファクトリメソッド from() で変換
data class OrderGetResponse(
    val orderId: String,
    val status: String,
    val customerName: String
) {
    companion object {
        fun from(detail: OrderDetail) = OrderGetResponse(
            orderId = detail.orderId,
            status = detail.status.name,
            customerName = detail.customerName
        )
    }
}
```

| 基準 | 判定 |
|------|------|
| ドメインモデルをそのままレスポンスに返す | REJECT |
| Request DTOにビジネスロジック | REJECT。バリデーションのみ許容 |
| Response DTOにドメインロジック（計算等） | REJECT |
| Request/Responseが同一の型 | REJECT |

### RESTful なアクション設計

状態遷移は動詞をサブリソースとして表現する。

```
POST   /api/orders              → 注文作成
GET    /api/orders/{id}         → 注文取得
GET    /api/orders              → 注文一覧
POST   /api/orders/{id}/approve → 承認（状態遷移）
POST   /api/orders/{id}/cancel  → キャンセル（状態遷移）
```

| 基準 | 判定 |
|------|------|
| PUT/PATCH でドメイン操作（approve, cancel等） | REJECT。POST + 動詞サブリソース |
| 1つのエンドポイントで複数の操作を分岐 | REJECT。操作ごとにエンドポイントを分ける |
| DELETE で論理削除 | REJECT。POST + cancel 等の明示的操作 |

## バリデーション戦略

バリデーションは層ごとに役割が異なる。すべてを1箇所に集めない。

| 層 | 責務 | 手段 | 例 |
|----|------|------|-----|
| API層 | 構造的バリデーション | `@NotBlank`, `init` ブロック | 必須項目、型、フォーマット |
| UseCase層 | ビジネスルール検証 | Read Modelへの問い合わせ | 重複チェック、前提条件の存在確認 |
| ドメイン層 | 状態遷移の不変条件 | `require` | 「PENDINGでないと承認できない」 |

```kotlin
// API層: 「入力の形が正しいか」
data class OrderPostRequest(
    @field:NotBlank val customerId: String,
    val from: LocalDateTime,
    val to: LocalDateTime
) {
    init {
        require(!to.isBefore(from)) { "終了日時は開始日時以降でなければなりません" }
    }
}

// UseCase層: 「ビジネス的に許可されるか」（Read Model参照）
fun execute(input: PlaceOrderInput) {
    customerRepository.findById(input.customerId)
        ?: throw CustomerNotFoundException("顧客が存在しません")
    validateNoOverlapping(input)  // 重複チェック
    commandGateway.send(buildCommand(input))
}

// ドメイン層: 「今の状態でこの操作は許されるか」
fun confirm(confirmedBy: String): OrderConfirmedEvent {
    require(status == OrderStatus.PENDING) { "確定できる状態ではありません" }
    return OrderConfirmedEvent(orderId, confirmedBy)
}
```

| 基準 | 判定 |
|------|------|
| ドメインの状態遷移ルールがAPI層にある | REJECT |
| ビジネスルール検証がControllerにある | REJECT。UseCase層に |
| 構造バリデーション（@NotBlank等）がドメインにある | REJECT。API層で |
| UseCase層のバリデーションがAggregate内にある | REJECT。Read Model参照はUseCase層 |

## エラーハンドリング

### 例外階層設計

ドメイン例外は sealed class で階層化する。HTTP ステータスコードへのマッピングは Controller 層で行う。

```kotlin
// ドメイン例外: sealed class で網羅性を保証
sealed class OrderException(message: String) : RuntimeException(message)
class OrderNotFoundException(message: String) : OrderException(message)
class InvalidOrderStateException(message: String) : OrderException(message)
class InsufficientStockException(message: String) : OrderException(message)

// Controller 層でHTTPステータスにマッピング
@RestControllerAdvice
class OrderExceptionHandler {
    @ExceptionHandler(OrderNotFoundException::class)
    fun handleNotFound(e: OrderNotFoundException) =
        ResponseEntity.status(HttpStatus.NOT_FOUND).body(ErrorResponse(e.message))

    @ExceptionHandler(InvalidOrderStateException::class)
    fun handleInvalidState(e: InvalidOrderStateException) =
        ResponseEntity.status(HttpStatus.CONFLICT).body(ErrorResponse(e.message))

    @ExceptionHandler(InsufficientStockException::class)
    fun handleInsufficientStock(e: InsufficientStockException) =
        ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(ErrorResponse(e.message))
}
```

| 基準 | 判定 |
|------|------|
| ドメイン例外にHTTPステータスコードが含まれる | REJECT。ドメインはHTTPを知らない |
| 汎用的な Exception や RuntimeException を throw | REJECT。具体的な例外型を使う |
| try-catch の空 catch | REJECT |
| Controller 内で例外を握りつぶして 200 を返す | REJECT |

## ドメインモデル設計

### イミュータブル + require

ドメインモデルは `data class`（イミュータブル）で設計し、`init` ブロックと `require` で不変条件を保証する。

```kotlin
data class Order(
    val orderId: String,
    val status: OrderStatus = OrderStatus.PENDING
) {
    // companion object の static メソッドで生成
    companion object {
        fun place(orderId: String, customerId: String): OrderPlacedEvent {
            require(customerId.isNotBlank()) { "Customer ID cannot be blank" }
            return OrderPlacedEvent(orderId, customerId)
        }
    }

    // インスタンスメソッドで状態遷移 → イベント返却
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING) { "確定できる状態ではありません" }
        return OrderConfirmedEvent(orderId, confirmedBy, LocalDateTime.now())
    }

    // イミュータブルな状態更新
    fun apply(event: OrderEvent): Order = when (event) {
        is OrderPlacedEvent -> Order(orderId = event.orderId)
        is OrderConfirmedEvent -> copy(status = OrderStatus.CONFIRMED)
        is OrderCancelledEvent -> copy(status = OrderStatus.CANCELLED)
    }
}
```

| 基準 | 判定 |
|------|------|
| ドメインモデルに var フィールド | REJECT。`copy()` でイミュータブルに更新 |
| バリデーションなしのファクトリ | REJECT。`require` で不変条件を保証 |
| ドメインモデルが外部サービスを呼ぶ | REJECT。純粋な関数のみ |
| setter でフィールドを直接変更 | REJECT |

### 値オブジェクト

プリミティブ型（String, Int）をドメインの意味でラップする。

```kotlin
// ID系: 型で取り違えを防止
data class OrderId(@get:JsonValue val value: String) {
    init { require(value.isNotBlank()) { "Order ID cannot be blank" } }
    override fun toString(): String = value
}

// 範囲系: 複合的な不変条件を保証
data class DateRange(val from: LocalDateTime, val to: LocalDateTime) {
    init { require(!to.isBefore(from)) { "終了日は開始日以降でなければなりません" } }
}

// メタ情報系: イベントペイロード内の付随情報
data class ApprovalInfo(val approvedBy: String, val approvalTime: LocalDateTime)
```

| 基準 | 判定 |
|------|------|
| 同じ型のIDが取り違えられる（orderId と customerId が両方 String） | 値オブジェクト化を検討 |
| 同じフィールドの組み合わせ（from/to等）が複数箇所に | 値オブジェクトに抽出 |
| 値オブジェクトに init ブロックがない | REJECT。不変条件を保証する |

## リポジトリパターン

ドメイン層でインターフェースを定義し、adapter/outbound で実装する。

```kotlin
// domain/: インターフェース（ポート）
interface OrderRepository {
    fun findById(orderId: String): Order?
    fun save(order: Order)
}

// adapter/outbound/persistence/: 実装（アダプター）
@Repository
class JpaOrderRepository(
    private val jpaRepository: OrderJpaRepository
) : OrderRepository {
    override fun findById(orderId: String): Order? {
        return jpaRepository.findById(orderId).orElse(null)?.toDomain()
    }
    override fun save(order: Order) {
        jpaRepository.save(OrderEntity.from(order))
    }
}
```

### Read Model Entity（JPA Entity）

Read Model 用の JPA Entity はドメインモデルとは別に定義する。var（mutable）が許容される。

```kotlin
@Entity
@Table(name = "orders")
data class OrderEntity(
    @Id val orderId: String,
    var customerId: String,
    @Enumerated(EnumType.STRING) var status: OrderStatus,
    var metadata: String? = null
)
```

| 基準 | 判定 |
|------|------|
| ドメインモデルを JPA Entity として兼用 | REJECT。分離する |
| Entity に ビジネスロジック | REJECT。Entity はデータ構造のみ |
| Repository 実装がドメイン層にある | REJECT。adapter/outbound に |

## 認証・認可の配置

認証・認可は横断的関心事として適切な層で処理する。

| 関心事 | 配置 | 手段 |
|-------|------|------|
| 認証（誰か） | Filter / Interceptor層 | JWT検証、セッション確認 |
| 認可（権限） | Controller層 | `@PreAuthorize("hasRole('ADMIN')")` |
| データアクセス制御（自分のデータのみ） | UseCase層 | ビジネスルールとして検証 |

```kotlin
// Controller層: ロールベースの認可
@PostMapping("/{id}/approve")
@PreAuthorize("hasRole('FACILITY_ADMIN')")
fun approve(@PathVariable id: String, @RequestBody request: ApproveRequest) { ... }

// UseCase層: データアクセス制御
fun execute(input: DeleteInput, currentUserId: String) {
    val entity = repository.findById(input.id)
        ?: throw NotFoundException("見つかりません")
    require(entity.ownerId == currentUserId) { "他のユーザーのデータは操作できません" }
    // ...
}
```

| 基準 | 判定 |
|------|------|
| 認可ロジックが UseCase 層やドメイン層にある | REJECT。Controller層で |
| データアクセス制御が Controller にある | REJECT。UseCase層で |
| 認証処理が Controller 内にある | REJECT。Filter/Interceptor で |

## テスト戦略

### テストピラミッド

```
        ┌─────────────┐
        │   E2E Test  │  ← 少数: API全体フロー確認
        ├─────────────┤
        │ Integration │  ← Repository, Controller の統合確認
        ├─────────────┤
        │  Unit Test  │  ← 多数: ドメインモデル、UseCase の独立テスト
        └─────────────┘
```

### ドメインモデルのテスト

ドメインモデルはフレームワーク非依存なので、純粋なユニットテストが書ける。

```kotlin
class OrderTest {
    // ヘルパー: 特定の状態の集約を構築
    private fun pendingOrder(): Order {
        val event = Order.place("order-1", "customer-1")
        return Order.from(event)
    }

    @Nested
    inner class Confirm {
        @Test
        fun `PENDING状態から確定できる`() {
            val order = pendingOrder()
            val event = order.confirm("admin-1")
            assertEquals("order-1", event.orderId)
        }

        @Test
        fun `CONFIRMED状態からは確定できない`() {
            val order = pendingOrder().let { it.apply(it.confirm("admin-1")) }
            assertThrows<IllegalArgumentException> {
                order.confirm("admin-2")
            }
        }
    }
}
```

テストのルール:
- 状態遷移をヘルパーメソッドで構築（テストごとに独立）
- `@Nested` で操作単位にグループ化
- 正常系と異常系（不正な状態遷移）を両方テスト
- `assertThrows` で例外の型を検証

### UseCase のテスト

UseCase はモックを使ってテスト。外部依存を注入する。

```kotlin
class PlaceOrderUseCaseTest {
    private val commandGateway = mockk<CommandGateway>()
    private val customerRepository = mockk<CustomerRepository>()
    private val useCase = PlaceOrderUseCase(commandGateway, customerRepository)

    @Test
    fun `顧客が存在しない場合はエラー`() {
        every { customerRepository.findById("unknown") } returns null

        assertThrows<CustomerNotFoundException> {
            useCase.execute(PlaceOrderInput(customerId = "unknown", items = listOf(...)))
        }
    }
}
```

| 基準 | 判定 |
|------|------|
| ドメインモデルのテストにモックを使用 | REJECT。ドメインは純粋にテスト |
| UseCase テストで実DBに接続 | REJECT。モックを使う |
| テストがフレームワークの起動を必要とする | ユニットテストなら REJECT |
| 状態遷移の異常系テストがない | REJECT |

## アンチパターン検出

以下を見つけたら REJECT:

| アンチパターン | 問題 |
|---------------|------|
| Smart Controller | Controller にビジネスロジックが集中 |
| Anemic Domain Model | ドメインモデルが setter/getter だけのデータ構造 |
| God Service | 1つの Service クラスに全操作が集中 |
| Repository直叩き | Controller が Repository を直接参照 |
| ドメイン漏洩 | adapter 層にドメインロジックが漏れる |
| Entity兼用 | JPA Entity をドメインモデルとして使い回す |
| 例外握りつぶし | 空の catch ブロック |
| Magic String | ハードコードされたステータス文字列等 |
