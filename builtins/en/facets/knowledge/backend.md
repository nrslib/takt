# Backend Expertise

## Hexagonal Architecture (Ports and Adapters)

Dependency direction flows from outer to inner layers. Reverse dependencies are prohibited.

```
adapter (external) → application (use cases) → domain (business logic)
```
Directory structure:

```
{domain-name}/
├── domain/                  # Domain layer (framework-independent)
│   ├── model/
│   │   └── aggregate/       # Aggregate roots, value objects
│   └── service/             # Domain services
├── application/             # Application layer (use cases)
│   ├── usecase/             # Orchestration
│   └── query/               # Query handlers
├── adapter/                 # Adapter layer (external connections)
│   ├── inbound/             # Input adapters
│   │   └── rest/            # REST Controller, Request/Response DTOs
│   └── outbound/            # Output adapters
│       └── persistence/     # Entity, Repository implementations
└── api/                     # Public interface (referenceable by other domains)
    └── events/              # Domain events
```

Layer responsibilities:

| Layer | Responsibility | May Depend On | Must Not Depend On |
|-------|---------------|---------------|-------------------|
| domain | Business logic, invariants | Standard library only | Frameworks, DB, external APIs |
| application | Use case orchestration | domain | Concrete adapter implementations |
| adapter/inbound | HTTP request handling, DTO conversion | application, domain | outbound adapter |
| adapter/outbound | DB persistence, external API calls | domain (interfaces) | application |

```kotlin
// CORRECT - Domain layer is framework-independent
data class Order(val orderId: String, val status: OrderStatus) {
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING)
        return OrderConfirmedEvent(orderId, confirmedBy)
    }
}

// WRONG - Spring annotations in domain layer
@Entity
data class Order(
    @Id val orderId: String,
    @Enumerated(EnumType.STRING) val status: OrderStatus
) {
    fun confirm(confirmedBy: String) { ... }
}
```


## API Layer Design (Controller)

Keep Controllers thin. Focus them on receiving requests, DTO conversion, resolving authentication/authorization boundaries, delegating to a UseCase or query boundary, and returning responses.

```kotlin
// CORRECT - Thin Controller
@RestController
@RequestMapping("/api/orders")
class OrdersController(
    private val placeOrderUseCase: PlaceOrderUseCase,
    private val queryGateway: QueryGateway
) {
    // Command: state change
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun post(@Valid @RequestBody request: OrderPostRequest): OrderPostResponse {
        val output = placeOrderUseCase.execute(request.toInput())
        return OrderPostResponse(output.orderId)
    }

    // Query: read
    @GetMapping("/{id}")
    fun get(@PathVariable id: String): ResponseEntity<OrderGetResponse> {
        val detail = queryGateway.query(FindOrderQuery(id), OrderDetail::class.java).join()
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(OrderGetResponse.from(detail))
    }
}

// WRONG - Business logic in Controller
@PostMapping
fun post(@RequestBody request: OrderPostRequest): ResponseEntity<Any> {
    // Validation, stock check, calculation... should NOT be in Controller
    val stock = inventoryRepository.findByProductId(request.productId)
    if (stock.quantity < request.quantity) {
        return ResponseEntity.badRequest().body("Insufficient stock")
    }
    val total = request.quantity * request.unitPrice * 1.1  // Tax calculation
    orderRepository.save(OrderEntity(...))
    return ResponseEntity.ok(...)
}
```

### Request/Response DTO Design

Define Request and Response as separate types. Never expose domain models directly via API.

```kotlin
// Request: validation annotations + init block
data class OrderPostRequest(
    @field:NotBlank val customerId: String,
    @field:NotNull val items: List<OrderItemRequest>
) {
    init {
        require(items.isNotEmpty()) { "Order must contain at least one item" }
    }

    fun toInput() = PlaceOrderInput(customerId = customerId, items = items.map { it.toItem() })
}

// Response: factory method from() for conversion
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


### RESTful Action Design

Express state transitions as verb sub-resources.

```
POST   /api/orders              → Create order
GET    /api/orders/{id}         → Get order
GET    /api/orders              → List orders
POST   /api/orders/{id}/approve → Approve (state transition)
POST   /api/orders/{id}/cancel  → Cancel (state transition)
```


## Validation Strategy

Validation has different roles at each layer. Do not centralize everything in one place.

| Layer | Responsibility | Mechanism | Example |
|-------|---------------|-----------|---------|
| API layer | Structural validation | `@NotBlank`, `init` block | Required fields, types, format |
| UseCase layer | Business rule verification | Read Model queries | Duplicate checks, precondition existence |
| Domain layer | State transition invariants | `require` | "Cannot approve unless PENDING" |

```kotlin
// API layer: "Is the input structurally correct?"
data class OrderPostRequest(
    @field:NotBlank val customerId: String,
    val from: LocalDateTime,
    val to: LocalDateTime
) {
    init {
        require(!to.isBefore(from)) { "End date must be on or after start date" }
    }
}

// UseCase layer: "Is this business-wise allowed?" (Read Model reference)
fun execute(input: PlaceOrderInput) {
    customerRepository.findById(input.customerId)
        ?: throw CustomerNotFoundException("Customer does not exist")
    validateNoOverlapping(input)  // Duplicate check
    commandGateway.send(buildCommand(input))
}

// Domain layer: "Is this operation allowed in current state?"
fun confirm(confirmedBy: String): OrderConfirmedEvent {
    require(status == OrderStatus.PENDING) { "Cannot confirm in current state" }
    return OrderConfirmedEvent(orderId, confirmedBy)
}
```


### Entry Validation Ownership

Give each entry constraint a single owner and a single enforcement mechanism. Validations with different purposes per layer are not duplication, but do not re-implement the same boundary and the same condition in multiple mechanisms. Where declarative validation is active, invalid input is rejected before the handler; the downstream check remains reachable for valid input but redundantly re-evaluates the same condition and cannot define the violation response. Whether declarative validation is actually active depends on the framework configuration — verify it, then make a single mechanism the effective owner.

```kotlin
// Avoid: same constraint twice; declarative validation owns the violation response
@GetMapping("/orders/{id}")
fun get(@PathVariable @Size(max = MAX_ID) id: String): OrderResponse {
    requireIdWithinLimit(id)  // runs only for valid input and cannot define the violation response
    return orderReadService.get(id).toResponse()
}

// Example: unify on the declaration and delete the procedural check
@GetMapping("/orders/{id}")
fun get(@PathVariable @Size(max = MAX_ID) id: String): OrderResponse =
    orderReadService.get(id).toResponse()
```

In the Spring example, constraints on scalar arguments such as `@PathVariable` or `@RequestParam` work only when method validation is active. Older setups commonly require class-level `@Validated`; Spring 6.1+ can use built-in method validation depending on configuration.

On a validation violation, the response may fall through to the framework's default translation outside your own exception hierarchy (some setups translate to 400, others leave it untranslated as 500). Judge not by whether a default translation is used, but by whether the status and response shape match the explicit API contract. The exception type thrown on violation depends on configuration and version, so do not guess; pin the actual exception and response with an integration test. Follow "Exception Translation Scope" for where the translation belongs.


### Read and Write Entrypoints

Separate read and write entrypoints. Read-side query boundaries have no side effects; writes are handled by commands or UseCases.


## Error Handling

### Exception Hierarchy Design

Domain exceptions are hierarchized using sealed classes. HTTP status code mapping is done at the Controller layer.

```kotlin
// Domain exceptions: sealed class ensures exhaustiveness
sealed class OrderException(message: String) : RuntimeException(message)
class OrderNotFoundException(message: String) : OrderException(message)
class InvalidOrderStateException(message: String) : OrderException(message)
class InsufficientStockException(message: String) : OrderException(message)

// Controller layer maps to HTTP status codes
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


### Exception Translation Scope

Translate exceptions into HTTP status codes at an exception translation layer on the HTTP adapter boundary. Global translation should be limited to truly cross-cutting cases such as authentication, input validation, and common error shapes; API- or resource-specific mappings belong in a boundary scoped to that API.


## Domain Model Design

### Immutable + require

Domain models are designed as `data class` (immutable), with invariants enforced via `init` blocks and `require`.

```kotlin
data class Order(
    val orderId: String,
    val status: OrderStatus = OrderStatus.PENDING
) {
    // Static factory method via companion object
    companion object {
        fun place(orderId: String, customerId: String): OrderPlacedEvent {
            require(customerId.isNotBlank()) { "Customer ID cannot be blank" }
            return OrderPlacedEvent(orderId, customerId)
        }
    }

    // Instance method for state transition → returns event
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING) { "Cannot confirm in current state" }
        return OrderConfirmedEvent(orderId, confirmedBy, LocalDateTime.now())
    }

    // Immutable state update
    fun apply(event: OrderEvent): Order = when (event) {
        is OrderPlacedEvent -> Order(orderId = event.orderId)
        is OrderConfirmedEvent -> copy(status = OrderStatus.CONFIRMED)
        is OrderCancelledEvent -> copy(status = OrderStatus.CANCELLED)
    }
}
```


### Value Objects

Wrap primitive types (String, Int) with domain meaning.

```kotlin
// ID types: prevent mix-ups via type safety
data class OrderId(@get:JsonValue val value: String) {
    init { require(value.isNotBlank()) { "Order ID cannot be blank" } }
    override fun toString(): String = value
}

// Range types: enforce compound invariants
data class DateRange(val from: LocalDateTime, val to: LocalDateTime) {
    init { require(!to.isBefore(from)) { "End date must be on or after start date" } }
}

// Metadata types: ancillary information in event payloads
data class ApprovalInfo(val approvedBy: String, val approvalTime: LocalDateTime)
```


## Repository Pattern

Define interface in domain layer, implement in adapter/outbound.

```kotlin
// domain/: Interface (port)
interface OrderRepository {
    fun findById(orderId: String): Order?
    fun save(order: Order)
}

// adapter/outbound/persistence/: Implementation (adapter)
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

### Read Model Entity (JPA Entity)

Read Model JPA Entities are defined separately from domain models. `var` (mutable) fields are acceptable here.

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


### Persistence Boundary for Structured Attributes

For structured attributes in relational or read-model persistence, choose the storage format based on update granularity, integrity, size, and schema evolution — not just current query requirements. Do not implicitly use a domain type's generic serialized form as the persistence contract; use a persistence-specific representation or an explicit mapping. Event-store type identifiers and payloads may use an explicit, versioned serialization contract.


Historical event-payload translation, relational database schema or data migration, and Read Model rebuilds are separate responsibilities. An upcaster translates versioned event payloads at the event-store restoration boundary. Database schema or data migration and Read Model rebuilds belong to their respective persistence boundaries and tests.

| Target | Placement |
|--------|-----------|
| Historical event-payload translation | Upcaster at the event-store restoration boundary |
| Relational schema or data transformation | Database migration boundary |
| Read Model derived from events | Read Model rebuild process |

## Authentication & Authorization Placement

Authentication and authorization are cross-cutting concerns handled at the appropriate layer.

| Concern | Placement | Mechanism |
|---------|-----------|-----------|
| Authentication (who) | Filter / Interceptor layer | JWT verification, session validation |
| Authorization (permissions) | Controller layer | `@PreAuthorize("hasRole('ADMIN')")` |
| Data access control (own data only) | UseCase layer | Verified as business rule |

```kotlin
// Controller layer: role-based authorization
@PostMapping("/{id}/approve")
@PreAuthorize("hasRole('FACILITY_ADMIN')")
fun approve(@PathVariable id: String, @RequestBody request: ApproveRequest) { ... }

// UseCase layer: data access control
fun execute(input: DeleteInput, currentUserId: String) {
    val entity = repository.findById(input.id)
        ?: throw NotFoundException("Not found")
    require(entity.ownerId == currentUserId) { "Cannot operate on another user's data" }
    // ...
}
```


## Distinguishing the Caller from the Domain Actor

Treat the API caller (authenticated principal) and the business actor recorded on the data (person in charge, author, confirmer) as separate concepts. They diverge on ingestion, delegated operations, and administrative paths.


The author of a memo is "whoever performed that operation"; the confirmer is "whoever performed the confirmation". Obtain the actor from each operation's performer. Facts determined later, such as the person in charge, are recorded at the operation/event that determines them — do not force a value at creation time.

```kotlin
// Avoid: Store the creation-time caller in state and reuse it as the actor of later operations
fun addMemo(text: String): MemoAddedEvent {
    return MemoAddedEvent(id, text, authorId = this.registeredBy)  // registrant != memo author
}

// Example: Receive the performer per operation
fun addMemo(text: String, authorId: String): MemoAddedEvent {
    return MemoAddedEvent(id, text, authorId = authorId)
}
```

## Test Strategy

### Test Pyramid

```
        ┌─────────────┐
        │   E2E Test  │  ← Few: verify full API flow
        ├─────────────┤
        │ Integration │  ← Repository, Controller integration verification
        ├─────────────┤
        │  Unit Test  │  ← Many: independent tests for domain models, UseCases
        └─────────────┘
```

### Domain Model Testing

Domain models are framework-independent, enabling pure unit tests.

```kotlin
class OrderTest {
    // Helper: build aggregate in specific state
    private fun pendingOrder(): Order {
        val event = Order.place("order-1", "customer-1")
        return Order.from(event)
    }

    @Nested
    inner class Confirm {
        @Test
        fun `can confirm from PENDING state`() {
            val order = pendingOrder()
            val event = order.confirm("admin-1")
            assertEquals("order-1", event.orderId)
        }

        @Test
        fun `cannot confirm from CONFIRMED state`() {
            val order = pendingOrder().let { it.apply(it.confirm("admin-1")) }
            assertThrows<IllegalArgumentException> {
                order.confirm("admin-2")
            }
        }
    }
}
```

Testing rules:
- Build state transitions via helper methods (each test is independent)
- Group by operation using `@Nested`
- Test both happy path and error cases (invalid state transitions)
- Verify exception types with `assertThrows`

### UseCase Testing

Test UseCases with mocks. Inject external dependencies.

```kotlin
class PlaceOrderUseCaseTest {
    private val commandGateway = mockk<CommandGateway>()
    private val customerRepository = mockk<CustomerRepository>()
    private val useCase = PlaceOrderUseCase(commandGateway, customerRepository)

    @Test
    fun `throws error when customer does not exist`() {
        every { customerRepository.findById("unknown") } returns null

        assertThrows<CustomerNotFoundException> {
            useCase.execute(PlaceOrderInput(customerId = "unknown", items = listOf(...)))
        }
    }
}
```
