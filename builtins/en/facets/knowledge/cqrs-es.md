# CQRS+ES Knowledge

## CQRS+ES Adoption Decision

CQRS+ES stores state changes as domain events and derives current state or Read Models from those events. Even when a backend or workflow uses CQRS+ES, not every new feature needs event sourcing.

| Criteria | Judgment |
|----------|----------|
| User request, design material, or existing boundary explicitly requires CQRS+ES | Adopt CQRS+ES |
| State transitions, lifecycle, and business invariants are central to the feature | Consider CQRS+ES |
| Change events trigger other aggregates, sagas, or downstream processes | Consider CQRS+ES |
| Point-in-time restoration, event replay, or audit evidence itself is required | Consider CQRS+ES |
| Multiple asynchronous read models are required for different query shapes | Consider CQRS+ES |
| Feature is only current-value lookup and update for admin settings | Prefer CRUD |
| Security settings, feature flags, allowlists, thresholds, or other immediate-effect settings | Prefer CRUD |
| No domain vocabulary beyond "create, update, delete" | Prefer CRUD |
| The work is running in a CQRS+ES workflow only | Not a justification |
| Task generation adds CQRS+ES requirements that did not exist in the source task | REJECT |

CQRS+ES adoption must come from requirements. An existing system containing CQRS+ES is a reason to align dependency direction and boundaries, but it is not a reason to event-source simple configuration tables.

### During Requirement Translation

If the source task or user request only describes CRUD-equivalent business requirements, do not add "commands, events, and projections" as new requirements in the task specification. If CQRS+ES necessity is unclear, document the adoption reason or leave it as an open question.

| Source request | Task-spec treatment |
|----------------|--------------------|
| "Manage allowed IPs per facility" | Treat as CRUD admin settings. Domain vocabulary is just "add/remove" with no business rules |
| "Manage order approval, cancellation, and returns where billing and inventory react to state changes" | CQRS+ES candidate. Complex state transitions, business invariants, and multiple aggregates in coordination |
| "Insurance policy amendments with review rules that vary by amendment type, where past assessment history influences future decisions" | CQRS+ES candidate. Business rules are complex and evolving; history itself is input to business decisions |
| "Show who changed what and when" | Check whether CRUD + audit log is sufficient. Display-only change history can be handled by audit columns |
| "Toggle notification settings on/off" | Treat as CRUD admin settings. Current-value lookup and update only |

CQRS+ES excels in complex business domains (finance, insurance, healthcare — domains where business rules are complex and evolve). Simple audit requirements or technical async processing alone are not sufficient grounds for CQRS+ES. The deciding factor is the complexity of the business logic.

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

## Event Evolution

Events are persisted contracts. When the current event type changes, old events must still be replayable. Translation of old events belongs in the upcaster / migration layer at the event-store boundary, not in the event type itself or in domain logic.

| Criteria | Judgment |
|----------|----------|
| Persisted event type or fields changed with no translation path | REJECT |
| Current event type keeps aliases or compatibility-only properties for old field names | REJECT. Keep history compatibility in upcasters |
| Aggregate or apply directly interprets old event shapes | REJECT. Convert to current events before replay |
| Event carries "previous value" only for compatibility | REJECT. Events represent the fact after it happened |
| Upcaster converts old payloads to the current event meaning | OK |
| Tests verify old payloads deserialize into current events through the upcaster | OK |

Responsibility split for event evolution:

| Responsibility | Place |
|----------------|-------|
| Current event meaning and fields | Event type |
| Translation of old payloads | Upcaster / migration layer |
| State restoration by event replay | Aggregate `apply` |
| Guarantee that old events can become current events | Upcaster tests |

```kotlin
// NG - mixing old-field compatibility into the current event type
data class OrderAssignedEvent(
    val orderId: String,
    @JsonAlias("assigneeId")
    val assigneeIds: List<String>
)

// OK - current event type represents only the current contract
data class OrderAssignedEvent(
    val orderId: String,
    val assigneeIds: List<String>
)
```

```kotlin
// OK - convert old payloads to current payloads in the upcaster
when (eventType) {
    OrderAssignedEvent::class.java.typeName -> {
        event.moveTextFieldToArray("assigneeId", "assigneeIds")
    }
}
```

Whether to keep old event classes depends on the framework and operations policy. In general, do not treat old classes as normal domain events; treat old serialized type names and payloads as the upcaster input contract and cover them with tests.

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

### Aggregate Decision Boundary

Aggregates make decisions only from state that can be restored from their event history and facts explicitly carried by commands. They are not the place to interpret, normalize, or authorize boundary-originated inputs.

Validation inside an Aggregate should be limited to facts reproducible by event replay. Other validation should be resolved before command dispatch, and the Aggregate should receive already-resolved facts.

| Decision target | Place |
|-----------------|-------|
| Whether the current state allows the operation | Aggregate |
| Whether the command requester matches the Aggregate owner | Aggregate |
| Whether HTTP/API input shape is valid | API layer |
| Parsing external identifiers such as object keys, URLs, or paths | UseCase layer or boundary-side Policy/Verifier |
| Whether an external identifier belongs to the current user/tenant | UseCase layer or boundary-side Policy/Verifier |
| Checking Read Models or other Aggregate state | UseCase layer |
| Checking that an external resource exists | Application-layer integration with the external service |

Example: for an upload-completed command, the Aggregate decides whether the session owner matches the requester and whether the current state can be completed. The storage object key format and whether the key belongs to the current user/tenant are validated in the UseCase layer before sending the command.

## UseCase Layer (Orchestration)

UseCases sit between Controllers and command dispatch when orchestration is needed. They validate preconditions from Read Models across aggregates and perform required preparation before sending commands.

```
Controller → UseCase → CommandGateway → Aggregate
                ↓
          QueryGateway / Repository (Read Model lookup)
```

Cases where UseCase is needed:
- Read Model checks from multiple aggregates before command dispatch
- Multiple validations executed in sequence
- Result consistency waiting after command dispatch
- External integration or multiple command dispatches

Cases where UseCase is unnecessary:
- Simple operation completed by sending one command from Controller
- Simple read that only queries the query side and converts to response
- Operation that checks resource existence/scope and then sends one command

| Criteria | Judgment |
|----------|----------|
| Controller directly references Repository for validation | Separate into UseCase layer |
| UseCase depends on HTTP requests/responses | REJECT. UseCase must be protocol-independent |
| UseCase directly modifies Aggregate internal state | REJECT. Use CommandGateway |
| UseCase waits for results via Subscription Query | REJECT. Does not work in distributed environments. Use reactive polling |
| UseCase only delegates to a query boundary or command dispatch | Consider deleting |

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

### External Work Triggers

External workers and asynchronous work should start from domain events confirmed by the Aggregate. Application Services and Coordinators must not bundle command dispatch and external side effects in the same control flow.

| Criteria | Judgment |
|----------|----------|
| Application Service or Coordinator dispatches a command, then starts external work for the same state transition | REJECT. Separate into an EventHandler for the confirmed event |
| Aggregate emits an event that represents generation or processing start, and an EventHandler starts external work | OK |
| EventHandler converts external start failure into a failure command back to the Aggregate | OK |
| Inputs needed by external work are represented in the event or reloadable through stable identifiers | OK |
| Inputs needed by external work exist only as local variables during command handling | REJECT. Move them to events or reloadable references |
| Saga is used only to start simple external work without contention or compensation | REJECT. EventHandler is sufficient |

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
| Query-side service or handler saves, deletes, or calls external APIs | REJECT |
| Command and Query responsibilities mixed in the same service | REJECT. Separate responsibility and naming |
| Query side checks existence or scope and caller dispatches command | OK |

### QueryHandler and ApplicationService Naming

In CQRS, the component that receives a query is the QueryHandler, and the entrypoint for dispatching queries is the QueryGateway / QueryBus. A facade called by Controllers for read use cases should be named ApplicationService or ReadService so it is not confused with a QueryHandler.

| Criteria | Judgment |
|----------|----------|
| Receives a Query, reads the Read Model, and returns a query result type | QueryHandler |
| Coordinates multiple Queries, authorization boundaries, pagination, or DTO assembly for Controllers | ApplicationService or ReadService |
| Class that only dispatches queries or coordinates reads is named QueryService | Warning. Easy to confuse with QueryHandler |
| QueryHandler knows HTTP requests/responses or Controller-specific error translation | REJECT |
| Simple read wrapper with no additional decision-making | Consider deleting. Controller may call QueryGateway directly |

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

### Async Callbacks and Concurrency Control

Completion notifications for asynchronous work must assume duplicates, delays, and reordering. Protect the workflow with Aggregate state transitions and command idempotency, not Controller-level or single-process locks.

| Criteria | Judgment |
|----------|----------|
| Controller or application-process lock prevents duplicate callbacks | REJECT. It does not work across multiple instances |
| Aggregate state decides whether work is processing | OK |
| Aggregate verifies callback attempt/generation identifiers | OK |
| Stale or duplicate callbacks are idempotently ignored by state transition | OK |
| Concurrency control is duplicated across Controller, UseCase, and Aggregate | REJECT |

## Eventual Consistency

When synchronous response is needed after command dispatch, use reactive polling to wait for Projection updates.

| Criteria | Judgment |
|----------|----------|
| Using Subscription Query to wait for Projection updates | REJECT. Does not work in distributed environments. Use reactive polling |
| Blocking the request thread with `Thread.sleep` or equivalent while waiting for Projection updates | REJECT. It can exhaust request threads under concurrency |
| Updated state must be returned in the same HTTP response | Wait non-blockingly on a reactive HTTP stack |
| The same HTTP response does not need to wait | `202 Accepted` + frontend long polling, regular polling, SSE, or WebSocket |
| UI expects immediate updates | Frontend polling, SSE, WebSocket, or server-side reactive waiting |
| Consistency delay exceeds tolerance | Reconsider architecture |
| Compensating transactions undefined | Request failure scenario review |

### Reactive Polling

Pattern: dispatch command → wait for Projection update completion with non-blocking polling. Reactive polling means waiting without occupying a request thread; it is not a synchronous `while` loop with `Thread.sleep`.

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

Avoid blocking waits:

```kotlin
// NG - Occupies the request thread and can exhaust the pool under load
while (Instant.now().isBefore(deadline)) {
    val order = orderRepository.findById(orderId).orElse(null)
    if (order?.status == OrderStatus.CONFIRMED) return PlaceOrderOutput(orderId)
    Thread.sleep(100)
}

// OK - If the same response must wait, move the wait onto a reactive path
return pollForCompletion(orderId).thenReturn(PlaceOrderOutput(orderId))
```

When polling is appropriate:
- Need to wait for Saga completion before returning response
- Need to return created resource ID after command dispatch

When polling is not needed:
- Simple operations that complete with just command dispatch (no result waiting)
- UI does not require real-time updates

When the server does not wait, return `202 Accepted` with a tracking ID after accepting the command, then let the frontend long-poll or regularly poll a read API. If the user experience requires immediate updates, SSE or WebSocket are also options.

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

## Master Data, Settings, and CRUD

Not everything in a CQRS+ES system needs event sourcing. Master data (reference data), admin settings, and allowlists with simple characteristics are often better implemented as plain CRUD because it is simpler and easier to maintain.

However, don't mechanically decide "it's master data, so CRUD". The more criteria below that apply, the more CRUD is suitable. Conversely, if an explicit requirement matches the CQRS+ES adoption criteria, consider adopting it.

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
- Current-value admin settings such as IP allowlists, feature flags, and notification settings

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
