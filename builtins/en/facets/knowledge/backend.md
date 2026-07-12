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

| Criteria | Judgment |
|----------|----------|
| Framework dependencies in domain layer (@Entity, @Component, etc.) | REJECT |
| Controller directly referencing Repository | REJECT. Must go through UseCase layer |
| Outward dependencies from domain layer (DB, HTTP, etc.) | REJECT |
| Direct dependencies between adapters (inbound → outbound) | REJECT |
| Types or identifiers in the application/domain layer carry protocol-specific meaning such as HTTP request/response, endpoint, or status code | REJECT. Translate them into use-case concepts at the boundary. A domain term that happens to contain words such as Request is not itself a violation |

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

| Criteria | Judgment |
|----------|----------|
| Returning domain model directly as response | REJECT |
| Business logic in Request DTO | REJECT. Only validation is allowed |
| Domain logic (calculations, etc.) in Response DTO | REJECT |
| Same type for Request and Response | REJECT |

### RESTful Action Design

Express state transitions as verb sub-resources.

```
POST   /api/orders              → Create order
GET    /api/orders/{id}         → Get order
GET    /api/orders              → List orders
POST   /api/orders/{id}/approve → Approve (state transition)
POST   /api/orders/{id}/cancel  → Cancel (state transition)
```

| Criteria | Judgment |
|----------|----------|
| PUT/PATCH for domain operations (approve, cancel, etc.) | REJECT. Use POST + verb sub-resource |
| Single endpoint branching into multiple operations | REJECT. Separate endpoints per operation |
| DELETE for soft deletion | REJECT. Use POST + explicit operation like cancel |

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

| Criteria | Judgment |
|----------|----------|
| Domain state transition rules in API layer | REJECT |
| Business rule verification in Controller | REJECT. Belongs in UseCase layer |
| Structural validation (@NotBlank, etc.) in domain | REJECT. Belongs in API layer |
| UseCase-level validation inside Aggregate | REJECT. Read Model queries belong in UseCase layer |

### Entry Validation Ownership

Give each entry constraint a single owner and a single enforcement mechanism. Validations with different purposes per layer are not duplication, but do not re-implement the same boundary and the same condition in multiple mechanisms. Where declarative validation is active, invalid input is rejected before the handler; the downstream check remains reachable for valid input but redundantly re-evaluates the same condition and cannot define the violation response. Whether declarative validation is actually active depends on the framework configuration — verify it, then make a single mechanism the effective owner.

```kotlin
// NG - same constraint twice; declarative validation owns the violation response
@GetMapping("/orders/{id}")
fun get(@PathVariable @Size(max = MAX_ID) id: String): OrderResponse {
    requireIdWithinLimit(id)  // runs only for valid input and cannot define the violation response
    return orderReadService.get(id).toResponse()
}

// OK - unify on the declaration and delete the procedural check
@GetMapping("/orders/{id}")
fun get(@PathVariable @Size(max = MAX_ID) id: String): OrderResponse =
    orderReadService.get(id).toResponse()
```

In the Spring example, constraints on scalar arguments such as `@PathVariable` or `@RequestParam` work only when method validation is active. Older setups commonly require class-level `@Validated`; Spring 6.1+ can use built-in method validation depending on configuration.

On a validation violation, the response may fall through to the framework's default translation outside your own exception hierarchy (some setups translate to 400, others leave it untranslated as 500). Judge not by whether a default translation is used, but by whether the status and response shape match the explicit API contract. The exception type thrown on violation depends on configuration and version, so do not guess; pin the actual exception and response with an integration test. Follow "Exception Translation Scope" for where the translation belongs.

| Criteria | Judgment |
|----------|----------|
| Same entry and same condition implemented in multiple validation mechanisms | REJECT. Make a single mechanism the effective owner and delete the unreachable side |
| Status and response shape on a validation violation do not match the explicit API contract (including implicit reliance on the default translation with no contract defined) | REJECT. Make the contract explicit and wire the translation |
| No test pinning the status and response shape on validation violation | REJECT. Verify the actual exception type with an integration test |
| Validation policy is inconsistent across entrypoints sharing the same trust boundary and input contract | REJECT. State the reason for the difference or unify the policy |
| External error contract depends on messages from the runtime's default locale | REJECT. Use stable error codes or explicit messages as the contract |
| Constraint values (max length, etc.) share a single constant across validation and API spec | OK |

### Read and Write Entrypoints

Separate read and write entrypoints. Read-side query boundaries have no side effects; writes are handled by commands or UseCases.

| Criteria | Judgment |
|----------|----------|
| Query boundary saves, deletes, calls external services, or dispatches commands | REJECT |
| Read-oriented class or method names hide side effects | REJECT |
| Simple read API calls a query boundary and converts to response DTO | OK |
| Simple state-changing API resolves structural validation and authorization boundary, then dispatches one command | OK |
| Read-side coordinator for Controllers handles authorization boundaries, multiple Read Models, pagination, etc. | Express as ApplicationService or ReadService |
| Sender or coordinating component named QueryService is placed near QueryHandlers | Warning. Easy to confuse with the query handling side |
| Controller contains multiple Read Model lookups, external integration, multiple commands, or result waiting | REJECT. Separate into UseCase layer |
| UseCase only delegates to another service or command dispatch without domain coordination | Consider deleting |

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

| Criteria | Judgment |
|----------|----------|
| HTTP status codes in domain exceptions | REJECT. Domain must not know about HTTP |
| Throwing generic Exception or RuntimeException | REJECT. Use specific exception types |
| Empty try-catch blocks | REJECT |
| Controller swallowing exceptions and returning 200 | REJECT |
| Expressing an actually reachable call pattern (e.g., a caller with a different role) as a 500 | REJECT. Make it an explicit 4xx; guarantee "unreachable" assumptions with authorization |

### Exception Translation Scope

Translate exceptions into HTTP status codes at an exception translation layer on the HTTP adapter boundary. Global translation should be limited to truly cross-cutting cases such as authentication, input validation, and common error shapes; API- or resource-specific mappings belong in a boundary scoped to that API.

| Criteria | Judgment |
|----------|----------|
| Each endpoint maps exceptions to HTTP representation through the same try-catch or wrapper | REJECT. Move it to an exception translation layer at the HTTP adapter boundary |
| API-specific exception mapping is added to a global handler | Scope is too broad. Keep it inside the target API boundary |
| Authentication failures, input validation, and common error shapes shared by all APIs | OK. Handle at a global boundary |
| HTTP representation mapping lives in the application or domain layer | REJECT. Keep it at the HTTP adapter boundary |
| Multiple translation layers handle the same exception type without a contract for scope and precedence | REJECT. Consolidate under a single owner or make the non-overlapping applicability explicit |

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

| Criteria | Judgment |
|----------|----------|
| `var` fields in domain model | REJECT. Use `copy()` for immutable updates |
| Factory without validation | REJECT. Enforce invariants with `require` |
| Domain model calling external services | REJECT. Pure functions only |
| Direct field mutation via setters | REJECT |

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

| Criteria | Judgment |
|----------|----------|
| Same-typed IDs that can be mixed up (orderId and customerId both String) | Consider wrapping in value objects |
| Same field combinations (from/to, etc.) appearing in multiple places | Extract to value object |
| Value object without init block | REJECT. Enforce invariants |

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

| Criteria | Judgment |
|----------|----------|
| Domain model doubling as JPA Entity | REJECT. Separate them |
| Business logic in Entity | REJECT. Entity is data structure only |
| Repository implementation in domain layer | REJECT. Belongs in adapter/outbound |

### Persistence Boundary for Structured Attributes

For structured attributes in relational or read-model persistence, choose the storage format based on update granularity, integrity, size, and schema evolution — not just current query requirements. Do not implicitly use a domain type's generic serialized form as the persistence contract; use a persistence-specific representation or an explicit mapping. Event-store type identifiers and payloads may use an explicit, versioned serialization contract; govern their evolution with the CQRS-ES compatibility and upcaster rules.

| Criteria | Judgment |
|----------|----------|
| Bounded structure read and written as a whole, with no need for search, joins, referential integrity, or partial updates | Consider a structured column (JSON, etc.) |
| Referential integrity, an independent lifecycle, or joins with other tables matter | Normalize into its own table |
| The DB's structured-column features (jsonb, etc.) can guarantee the needed search, indexing, and partial updates, and integrity requirements are met | A structured column is also a valid choice |
| Domain type is converted directly by a generic serializer, implicitly using its field names as the DB schema | REJECT. Insert a persistence-specific representation or an explicit mapping |
| Field changes to stored structures have no chosen path among compatible reads, migration, or rebuild, and no test pinning it | REJECT. Choose one path and pin it with a test |

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

| Criteria | Judgment |
|----------|----------|
| Authorization logic in UseCase or domain layer | REJECT. Belongs in Controller layer |
| Data access control in Controller | REJECT. Belongs in UseCase layer |
| Authentication processing inside Controller | REJECT. Belongs in Filter/Interceptor |
| Application-layer service reads the security context directly (e.g., resolving the current user) | REJECT. Resolve at the boundary and pass as an argument |
| The same authorization check is duplicated in the Controller and a lower layer | REJECT. Consolidate the responsibility in one place |

## Distinguishing the Caller from the Domain Actor

Treat the API caller (authenticated principal) and the business actor recorded on the data (person in charge, author, confirmer) as separate concepts. They diverge on ingestion, delegated operations, and administrative paths.

| Criteria | Judgment |
|----------|----------|
| Unconditionally recording the caller as the business actor | Warning. Verify it does not break on ingestion, delegated, or administrative paths |
| Reusing the creation-time caller, via state, as the actor of later operations | REJECT. Pass the performer as an argument per operation |
| Requiring an actor field before the business actor is actually determined | Warning. Check whether it can be recorded at the operation that determines it (approval, confirmation, etc.) |
| Resolving denormalized display names (etc.) at the boundary of the operation that establishes the fact | OK |
| Placing resolution logic that assumes the caller is a member of the resource on a path also used by non-members | REJECT |

The author of a memo is "whoever performed that operation"; the confirmer is "whoever performed the confirmation". Obtain the actor from each operation's performer. Facts determined later, such as the person in charge, are recorded at the operation/event that determines them — do not force a value at creation time.

```kotlin
// NG - Store the creation-time caller in state and reuse it as the actor of later operations
fun addMemo(text: String): MemoAddedEvent {
    return MemoAddedEvent(id, text, authorId = this.registeredBy)  // registrant != memo author
}

// OK - Receive the performer per operation
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

| Criteria | Judgment |
|----------|----------|
| Using mocks for domain model tests | REJECT. Test domain purely |
| UseCase tests connecting to real DB | REJECT. Use mocks |
| Tests requiring framework startup | REJECT for unit tests |
| Missing error case tests for state transitions | REJECT |

## Anti-Pattern Detection

REJECT when these patterns are found:

| Anti-Pattern | Problem |
|--------------|---------|
| Smart Controller | Business logic concentrated in Controller |
| Anemic Domain Model | Domain model is just a data structure with setters/getters |
| God Service | All operations concentrated in a single Service class |
| Direct Repository Access | Controller directly referencing Repository |
| Domain Leakage | Domain logic leaking into adapter layer |
| Entity Reuse | JPA Entity reused as domain model |
| Swallowed Exceptions | Empty catch blocks |
| Magic Strings | Hardcoded status strings, etc. |
