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


## API層設計（Controller）

Controller は薄く保つ。リクエスト受信、DTO変換、認証・認可境界の解決、UseCaseまたは問い合わせ層への委譲、レスポンス返却に集中する。

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


### RESTful なアクション設計

状態遷移は動詞をサブリソースとして表現する。

```
POST   /api/orders              → 注文作成
GET    /api/orders/{id}         → 注文取得
GET    /api/orders              → 注文一覧
POST   /api/orders/{id}/approve → 承認（状態遷移）
POST   /api/orders/{id}/cancel  → キャンセル（状態遷移）
```


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


### 入口バリデーションの所有権

同一の入口制約は一つの所有者と実行機構に寄せる。層ごとに目的が異なる検証は重複ではないが、同じ境界・同じ条件を複数方式で再実装しない。宣言的検証が有効な構成では、不正入力は処理本体より前に拒否される。後段の手書きチェックは正常入力では到達するが、同じ条件を冗長に再評価するだけで、違反時の応答を決定できない。宣言的検証が実際に有効かどうかはフレームワークの構成に依存するため、確認したうえで実効的な所有者を一つにする。

```kotlin
// 避ける例: 同じ制約の二重実装。違反時の応答は宣言的検証が所有する
@GetMapping("/orders/{id}")
fun get(@PathVariable @Size(max = MAX_ID) id: String): OrderResponse {
    requireIdWithinLimit(id)  // 正常入力でのみ実行され、違反時の応答は決定できない
    return orderReadService.get(id).toResponse()
}

// 例: 宣言に一本化し、手続き的チェックを削除
@GetMapping("/orders/{id}")
fun get(@PathVariable @Size(max = MAX_ID) id: String): OrderResponse =
    orderReadService.get(id).toResponse()
```

Spring の例では、`@PathVariable` や `@RequestParam` のようなスカラー引数の制約は method validation が有効な前提で機能する。古い構成では Controller クラスへの `@Validated` が必要になることが多く、Spring 6.1+ では構成に応じて組み込みの method validation を使える。

検証違反時の応答は、自前の例外階層の外でフレームワーク既定の変換に落ちることがある（400 へ変換する構成もあれば、未変換のまま 500 になる構成もある）。既定の変換を使うこと自体ではなく、明示した API 契約（ステータス・応答形状）と一致しているかで判定する。違反時に投げられる例外の型は構成やバージョンに依存するため推測せず、統合テストで実際に飛ぶ例外と応答を固定する。変換の配置は「例外変換のスコープ」に従う。


### 読み取りと書き込みの入口

読み取りと書き込みは入口で分離する。読み取り用の問い合わせ層は副作用を持たず、書き込みはコマンドまたはUseCaseで扱う。


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


### 例外変換のスコープ

HTTPステータスへの例外変換は、HTTP adapter 境界の例外変換レイヤに分離する。グローバルな変換は認証・入力検証・共通エラー形状など真に横断的なものに限り、特定 API やリソース固有の変換は、その API スコープに閉じた境界で扱う。


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


### 構造化属性の永続化境界

relational / Read Model 永続化の構造化属性は、現在の検索要件だけでなく、更新単位、整合性、サイズ、スキーマ進化を基準に保存形式を選ぶ。ドメイン型の汎用シリアライズ結果を暗黙の永続化契約にせず、永続化専用の表現または明示的な変換を使う。イベントストアの型識別子と payload は、明示的かつバージョン管理されたシリアライズ契約としてよい。


履歴イベントpayloadの変換、relational database の schema / data migration、Read Model rebuild は別の責務である。upcaster はイベントストアから復元する境界で versioned event payload を変換する。DB schema / data migration と Read Model rebuild は、それぞれの永続化境界とテストで扱う。

| 対象 | 置き場所 |
|------|----------|
| 履歴イベントpayloadの変換 | イベントストア復元境界の upcaster |
| relational schema / data の変換 | DB migration 境界 |
| イベントから導出可能な Read Model | Read Model rebuild 処理 |

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


## 呼び出し者とドメイン上のアクターの区別

API の呼び出し者（認証主体）と、記録に残す業務上のアクター（担当者・作成者・確定者）は別の概念として扱う。取り込み・代理操作・管理経路では両者が一致しない。


メモの作成者は「その操作をした本人」、確定者は「確定操作をした本人」のように、アクターは各操作の実行者から都度取得する。担当者のように後から確定する事実は、確定を表す操作・イベントの時点で記録し、作成時に無理に埋めない。

```kotlin
// 避ける例: 作成時の呼び出し者を状態に保存し、後続操作のアクターとして流用
fun addMemo(text: String): MemoAddedEvent {
    return MemoAddedEvent(id, text, authorId = this.registeredBy)  // 登録者 ≠ メモ作成者
}

// 例: 操作ごとに実行者を受け取る
fun addMemo(text: String, authorId: String): MemoAddedEvent {
    return MemoAddedEvent(id, text, authorId = authorId)
}
```

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
