# CQRS+ES Knowledge

## Aggregate Design

Aggregates hold only fields necessary for decision-making.

Command Model (Aggregate) role is to "receive commands, make decisions, and emit events". Query data is handled by Read Model (Projection).

"Necessary for decision" means:
- Used in `if`/`require` conditional branches
- Field value referenced when emitting events in instance methods

| Criteria | Judgment |
|----------|----------|
| Aggregate spans multiple transaction boundaries | REJECT |
| Direct references between Aggregates (not ID references) | REJECT |
| Aggregate exceeds 100 lines | Consider splitting |
| Business invariants exist outside Aggregate | REJECT |
| Holding fields not used for decisions | REJECT |

Good Aggregate:
```kotlin
// Only fields necessary for decisions
data class Order(
    val orderId: String,      // Used when emitting events
    val status: OrderStatus   // Used for state checking
) {
    fun confirm(confirmedBy: String): OrderConfirmedEvent {
        require(status == OrderStatus.PENDING) { "Cannot confirm in this state" }
        return OrderConfirmedEvent(
            orderId = orderId,
            confirmedBy = confirmedBy,
            confirmedAt = LocalDateTime.now()
        )
    }
}

// Holding fields not used for decisions (NG)
data class Order(
    val orderId: String,
    val customerId: String,     // Not used for decisions
    val shippingAddress: Address, // Not used for decisions
    val status: OrderStatus
)
```

Aggregates with no additional operations have ID only:
```kotlin
// When only creation, no additional operations
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

## Event Design

| Criteria | Judgment |
|----------|----------|
| Event not in past tense (Created → Create) | REJECT |
| Event contains logic | REJECT |
| Event contains internal state of other Aggregates | REJECT |
| Event schema not version controlled | Warning |
| CRUD-style events (Updated, Deleted) | Needs review |

Good Events:
```kotlin
// Good: Domain intent is clear
OrderPlaced, PaymentReceived, ItemShipped

// Bad: CRUD style
OrderUpdated, OrderDeleted
```

Event Granularity:
- Too fine: `OrderFieldChanged` → Domain intent unclear
- Appropriate: `ShippingAddressChanged` → Intent is clear
- Too coarse: `OrderModified` → What changed is unclear

## Command Handlers

| Criteria | Judgment |
|----------|----------|
| Handler directly manipulates DB | REJECT |
| Handler modifies multiple Aggregates | REJECT |
| No command validation | REJECT |
| Handler executes queries to make decisions | Needs review |

Good Command Handler:
```
1. Receive command
2. Restore Aggregate from event store
3. Apply command to Aggregate
4. Save emitted events
```

## Projection Design

| Criteria | Judgment |
|----------|----------|
| Projection issues commands | REJECT |
| Projection references Write model | REJECT |
| Single projection serves multiple use cases | Needs review |
| Design that cannot be rebuilt | REJECT |

Good Projection:
- Optimized for specific read use case
- Idempotently reconstructible from events
- Completely independent from Write model

## Query Side Design

Controller uses QueryGateway. Does not use Repository directly.

Types between layers:
- `application/query/` - Query result types (e.g., `OrderDetail`)
- `adapter/protocol/` - REST response types (e.g., `OrderDetailResponse`)
- QueryHandler returns application layer types, Controller converts to adapter layer types

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

// QueryHandler - returns application layer type
@QueryHandler
fun handle(query: GetOrderDetailQuery): OrderDetail? {
    val entity = repository.findById(query.id) ?: return null
    return OrderDetail(...)
}

// Controller - converts to adapter layer type
@GetMapping("/{id}")
fun getById(@PathVariable id: String): ResponseEntity<OrderDetailResponse> {
    val detail = queryGateway.query(
        GetOrderDetailQuery(id),
        OrderDetail::class.java
    ).join() ?: throw NotFoundException("...")

    return ResponseEntity.ok(OrderDetailResponse.from(detail))
}
```

Structure:
```
Controller (adapter) → QueryGateway → QueryHandler (application) → Repository
     ↓                                      ↓
Response.from(detail)                  OrderDetail
```

## Eventual Consistency

| Situation | Response |
|-----------|----------|
| UI expects immediate updates | Redesign or polling/WebSocket |
| Consistency delay exceeds tolerance | Reconsider architecture |
| Compensating transactions undefined | Request failure scenario review |

## Saga vs EventHandler

Saga is used only for "operations between multiple aggregates where contention occurs".

Cases where Saga is needed:
```
When multiple actors compete for the same resource
Example: Inventory reservation (10 people ordering the same product simultaneously)

OrderPlacedEvent
  ↓ InventoryReservationSaga
ReserveInventoryCommand → Inventory aggregate (serializes concurrent execution)
  ↓
InventoryReservedEvent → ConfirmOrderCommand
InventoryReservationFailedEvent → CancelOrderCommand
```

Cases where Saga is not needed:
```
Non-competing operations
Example: Inventory release on order cancellation

OrderCancelledEvent
  ↓ InventoryReleaseHandler (simple EventHandler)
ReleaseInventoryCommand
  ↓
InventoryReleasedEvent
```

Decision criteria:

| Situation | Saga | EventHandler |
|-----------|------|--------------|
| Resource contention exists | Use | - |
| Compensating transaction needed | Use | - |
| Non-competing simple coordination | - | Use |
| Retry on failure is sufficient | - | Use |

Anti-pattern:
```kotlin
// NG - Using Saga for lifecycle management
@Saga
class OrderLifecycleSaga {
    // Tracking all order state transitions in Saga
    // PLACED → CONFIRMED → SHIPPED → DELIVERED
}

// OK - Saga only for operations requiring eventual consistency
@Saga
class InventoryReservationSaga {
    // Only for inventory reservation concurrency control
}
```

Saga is not a lifecycle management tool. Create it per "operation" that requires eventual consistency.

## Exception vs Event (Failure Handling)

Failures not requiring audit use exceptions, failures requiring audit use events.

Exception approach (recommended: most cases):
```kotlin
// Domain model: Throws exception on validation failure
fun reserveInventory(orderId: String, quantity: Int): InventoryReservedEvent {
    if (availableQuantity < quantity) {
        throw InsufficientInventoryException("Insufficient inventory")
    }
    return InventoryReservedEvent(productId, orderId, quantity)
}

// Saga: Catch with exceptionally and perform compensating action
commandGateway.send<Any>(command)
    .exceptionally { ex ->
        commandGateway.send<Any>(CancelOrderCommand(
            orderId = orderId,
            reason = ex.cause?.message ?: "Inventory reservation failed"
        ))
        null
    }
```

Event approach (rare cases):
```kotlin
// Only when audit is required
data class PaymentFailedEvent(
    val paymentId: String,
    val reason: String,
    val attemptedAmount: Money
) : PaymentEvent
```

Decision criteria:

| Question | Exception | Event |
|----------|-----------|-------|
| Need to check this failure later? | No | Yes |
| Required by regulations/compliance? | No | Yes |
| Only Saga cares about the failure? | Yes | No |
| Is there value in keeping it in Event Store? | No | Yes |

Default is exception approach. Consider events only when audit requirements exist.

## Abstraction Level Evaluation

**Conditional branch proliferation detection:**

| Pattern | Judgment |
|---------|----------|
| Same if-else pattern in 3+ places | Abstract with polymorphism → REJECT |
| switch/case with 5+ branches | Consider Strategy/Map pattern |
| Event type branching proliferating | Separate event handlers → REJECT |
| Complex state branching in Aggregate | Consider State Pattern |

**Abstraction level mismatch detection:**

| Pattern | Problem | Fix |
|---------|---------|-----|
| DB operation details in CommandHandler | Responsibility violation | Separate to Repository layer |
| Business logic in EventHandler | Responsibility violation | Extract to domain service |
| Persistence in Aggregate | Layer violation | Change to EventStore route |
| Calculation logic in Projection | Hard to maintain | Extract to dedicated service |

Good abstraction examples:

```kotlin
// Event type branching proliferation (NG)
@EventHandler
fun on(event: DomainEvent) {
    when (event) {
        is OrderPlacedEvent -> handleOrderPlaced(event)
        is OrderConfirmedEvent -> handleOrderConfirmed(event)
        is OrderShippedEvent -> handleOrderShipped(event)
        // ...keeps growing
    }
}

// Separate handlers per event (OK)
@EventHandler
fun on(event: OrderPlacedEvent) { ... }

@EventHandler
fun on(event: OrderConfirmedEvent) { ... }

@EventHandler
fun on(event: OrderShippedEvent) { ... }
```

```kotlin
// Complex state branching (NG)
fun process(command: ProcessCommand) {
    when (status) {
        PENDING -> if (command.type == "approve") { ... } else if (command.type == "reject") { ... }
        APPROVED -> if (command.type == "ship") { ... }
        // ...gets complex
    }
}

// Abstracted with State Pattern (OK)
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

## Anti-pattern Detection

REJECT if found:

| Anti-pattern | Problem |
|--------------|---------|
| CRUD Disguise | Just splitting CRUD into Command/Query |
| Anemic Domain Model | Aggregate is just a data structure |
| Event Soup | Meaningless events proliferate |
| Temporal Coupling | Implicit dependency on event order |
| Missing Events | Important domain events are missing |
| God Aggregate | All responsibilities in one Aggregate |

## Test Strategy

Separate test strategies by layer.

Test Pyramid:
```
        ┌─────────────┐
        │   E2E Test  │  ← Few: Overall flow confirmation
        ├─────────────┤
        │ Integration │  ← Command→Event→Projection→Query coordination
        ├─────────────┤
        │  Unit Test  │  ← Many: Each layer tested independently
        └─────────────┘
```

Command side (Aggregate):
```kotlin
// Using AggregateTestFixture
@Test
fun `confirm command emits event`() {
    fixture
        .given(OrderPlacedEvent(...))
        .`when`(ConfirmOrderCommand(orderId, confirmedBy))
        .expectSuccessfulHandlerExecution()
        .expectEvents(OrderConfirmedEvent(...))
}
```

Query side:
```kotlin
// Direct Read Model setup + QueryGateway
@Test
fun `can get order details`() {
    // Given: Setup Read Model directly
    orderRepository.save(OrderEntity(...))

    // When: Execute query via QueryGateway
    val detail = queryGateway.query(GetOrderDetailQuery(orderId), ...).join()

    // Then
    assertEquals(expectedDetail, detail)
}
```

Checklist:

| Aspect | Judgment |
|--------|----------|
| Aggregate tests verify events not state | Required |
| Query side tests don't create data via Command | Recommended |
| Integration tests consider Axon async processing | Required |

## Infrastructure Layer

Check:
- Is event store choice appropriate?
- Does messaging infrastructure meet requirements?
- Is snapshot strategy defined?
- Is event serialization format appropriate?
