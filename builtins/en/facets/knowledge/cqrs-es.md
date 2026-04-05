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

Query side operates on an event-driven PubSub model. Projections update Read Models via EventHandler, and queries read from Read Models.

Event distribution uses PubSub (via message broker) to deliver events to all instances. Do not use mechanisms that assume delivery to the same instance.

- **Subscription Query** (e.g., Axon's `subscriptionQuery()`): delivers change notifications back to the subscribing instance, but in distributed environments or when using third-party event store plugins, the subscribing instance and the notified instance may differ, making it impossible to return the response on the same machine. When synchronous response is needed, use reactive polling to wait for Read Model updates.
- **Subscribing event processor** (e.g., Axon's `SubscribingEventProcessor`): relies on local event bus subscription, so only the instance that emitted the event receives it. In distributed environments, other instances' Projections are not updated. Use PubSub to distribute events to all instances.

| Criteria | Judgment |
|----------|----------|
| Using Subscription Query (e.g., Axon's `subscriptionQuery()`) | REJECT. Does not work in distributed environments. Use reactive polling |
| Using Subscribing event processor (e.g., Axon's `SubscribingEventProcessor`) | REJECT. Local delivery only. Other instances not updated in distributed environments |
| Controller directly referencing Repository | REJECT. Must go through UseCase layer |
| Query side referencing Command Model | REJECT |
| QueryHandler issuing commands | REJECT |

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

// Controller - synchronous return is fine for simple reads
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

Event flow (PubSub):
Aggregate → Event Bus → Projection(@EventHandler) → Repository(Read Model)
                                                          ↑
                                          QueryHandler reads from here
```

## Eventual Consistency

When synchronous response is needed after command dispatch, use reactive polling to wait for Projection updates.

| Criteria | Judgment |
|----------|----------|
| Using Subscription Query to wait for Projection updates | REJECT. Does not work in distributed environments. Use reactive polling |
| UI expects immediate updates | Polling or WebSocket |
| Consistency delay exceeds tolerance | Reconsider architecture |
| Compensating transactions undefined | Request failure scenario review |

### Reactive Polling

Pattern: dispatch command → poll for Projection update completion.

```kotlin
// UseCase: send command → poll for completion
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

// Polling: wait for Projection update
private fun pollForCompletion(orderId: String): Mono<Void> {
    return ReactivePolling.waitFor(
        supplier = { orderRepository.findById(orderId).orElse(null) },
        condition = { it.sagaCompleted || it.status == OrderStatus.CONFIRMED },
        timeout = Duration.ofSeconds(60),
        maxAttempts = 300
    )
}
```

When polling is appropriate:
- Need to wait for Saga completion before returning response
- Need to return created resource ID after command dispatch

When polling is not needed:
- Simple operations that complete with just command dispatch (no result waiting)
- UI does not require real-time updates

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

## Master Data and CRUD

Not everything in a CQRS+ES system needs event sourcing. Master data (reference data) with simple characteristics is better implemented as plain CRUD — it's simpler and easier to maintain.

However, don't mechanically decide "it's master data, so CRUD". The more criteria below that apply, the more CRUD is suitable. Conversely, if even one requirement calls for CQRS+ES, consider adopting it.

**Criteria for determining CRUD is sufficient:**

| Aspect | Leans CRUD | Leans CQRS+ES |
|--------|-----------|---------------|
| Business requirements | Just "manage X" with no special mentions | Specific business rules or constraints |
| Logic evolution | Simple reference/update, no foreseeable complexity | State transitions or lifecycle may grow complex |
| Change history / audit | No need to track "who changed what when" | Change history or audit trail required |
| Domain events | Changes don't affect other aggregates or processes | Changes trigger downstream processes |
| Consistency scope | Self-contained, no cross-aggregate consistency needed | Must maintain consistency with other aggregates |
| Point-in-time queries | No "what was the state at time T" queries | Point-in-time queries required |

**Typical CRUD candidates:**
- Code masters such as prefecture/country codes
- Classification masters such as categories and tags
- Configuration values, constant tables

**Cases where CQRS+ES is justified:**
- Product master, but price change history tracking is needed
- Organization master, but changes trigger permission recalculation
- Business partner master, but has credit assessment state transitions

```kotlin
// CRUD is sufficient: Simple category master
@Entity
data class Category(
    @Id val categoryId: String,
    val name: String,
    val displayOrder: Int
)

// CQRS+ES is appropriate: Product with price change history tracking
data class Product(
    val productId: String,
    val currentPrice: Money
) {
    fun changePrice(newPrice: Money, reason: String): PriceChangedEvent {
        require(newPrice.amount > BigDecimal.ZERO) { "Price must be positive" }
        return PriceChangedEvent(productId, currentPrice, newPrice, reason)
    }
}
```

Even when implementing with CRUD, other aggregates in the CQRS+ES system reference CRUD entities by ID. The principle that CRUD entities don't directly access aggregate internal state still applies.

## Infrastructure Layer

Check:
- Is event store choice appropriate?
- Does messaging infrastructure meet requirements?
- Is snapshot strategy defined?
- Is event serialization format appropriate?
