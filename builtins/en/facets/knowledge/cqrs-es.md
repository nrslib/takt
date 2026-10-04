# CQRS+ES Knowledge

## CQRS+ES Adoption Decision

CQRS+ES is a design in which state changes are stored as domain events, and current state and Read Models are derived from them. Even when the backend as a whole or the workflow handles CQRS+ES, not every new feature needs to be implemented with event sourcing.

Adopt CQRS+ES based on requirements. An existing system containing CQRS+ES can justify aligning dependencies and boundaries, but it does not justify event-sourcing simple settings tables.

### Requirement Transformation

If the original requirements or user request states only CRUD-equivalent business requirements, do not add "commands, events, and projections" as new requirements in the specification. If it is unclear whether CQRS+ES is needed, state the adoption rationale or leave it as an open question.

| Original Request | How to Convert into a Specification |
|------------------|-------------------------------------|
| "Manage allowed IPs per facility" | Treat as CRUD-managed settings. The domain vocabulary is only "add/delete" and has no business rules |
| "Manage order approval, cancellation, and returns, and trigger billing or inventory depending on state" | Candidate for CQRS+ES. Complex state transitions and business invariants, with multiple Aggregates interacting |
| "For insurance contract changes, review rules differ by change type, and past assessment history affects future decisions" | Candidate for CQRS+ES. Business rules are complex and change over time; history itself is input to business decisions |
| "Show who changed what and when on the screen" | Check whether CRUD + audit logs is enough. If the requirement is only displaying change history, audit columns are often sufficient |
| "Toggle notification settings on/off" | Treat as CRUD-managed settings. It only references and updates current values |

CQRS+ES is most valuable in complex business domains, such as finance, insurance, or healthcare, where business rules are complex and change over time. Simple audit requirements or technical asynchronous processing alone are not sufficient conditions for CQRS+ES. The decision axis is business-logic complexity.

## Aggregate Design

Aggregates hold only fields necessary for decision-making.

The Command Model (Aggregate) role is to "receive commands, make decisions, and emit events". Query data belongs to the Read Model (Projection).

"Necessary for decision-making" means:
- Used in `if` / `require` conditional branches
- Field values are referenced by instance methods when emitting events

Being used in an `if` / `require` branch is not enough to justify keeping a field in Aggregate state. First verify that the branch or validation is an essential invariant of the whole Aggregate.

### Origin Metadata and Invariants

Origin metadata such as input source, channel, producer, or integration source can be needed for display, search, audit, or integration tracing. That need alone does not justify restoring it as Aggregate state.

```kotlin
// Avoid: Origin metadata narrows the normal lifecycle of an existing Aggregate
data class Note(
    val noteId: String,
    val sourceType: SourceType?,
    val targetIds: List<String>,
) {
    fun update(text: String, targetIds: List<String>): NoteUpdatedEvent {
        if (sourceType == SourceType.EXTERNAL_IMPORT) {
            require(targetIds.isNotEmpty())
        }
        return NoteUpdatedEvent(noteId, text, targetIds)
    }
}

// Example: Track origin in events/read models and align Aggregate invariants with the normal lifecycle
data class Note(
    val noteId: String,
    val confirmed: Boolean,
) {
    fun update(text: String, targetIds: List<String>): NoteUpdatedEvent {
        check(!confirmed)
        return NoteUpdatedEvent(noteId, text, targetIds)
    }
}

data class NoteCreatedEvent(
    val noteId: String,
    val text: String,
    val targetIds: List<String>,
    val sourceType: SourceType?, // Origin fact used by projections or audit
)
```

### Existing Lifecycle Priority

When integrating a new input flow into an existing Aggregate, prefer the existing normal lifecycle. Do not add input-source-specific commands, wrappers, services, or deletion paths merely because the input source differs.

Good Aggregate:
```kotlin
// Only fields necessary for decisions
data class Order(
    val orderId: String,      // Used when emitting events
    val status: OrderStatus   // Used for state checks
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
    val customerId: String,       // Not used for decisions
    val shippingAddress: Address, // Not used for decisions
    val status: OrderStatus
)
```

Aggregates with no additional operations have only an ID:
```kotlin
// Creation only, no additional operations
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

### Adapter Pattern: Separating Domain from Framework

Do not put framework annotations such as `@Aggregate` or `@CommandHandler` directly on domain models. Adapter classes handle framework integration, and domain models focus on business logic.

```kotlin
// Domain model: framework-independent business logic only
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
        require(status == OrderStatus.PENDING) { "Cannot confirm in this state" }
        return OrderConfirmedEvent(orderId, confirmedBy, LocalDateTime.now())
    }

    fun apply(event: OrderEvent): Order = when (event) {
        is OrderPlacedEvent -> from(event)
        is OrderConfirmedEvent -> copy(status = OrderStatus.CONFIRMED)
        is OrderCancelledEvent -> copy(status = OrderStatus.CANCELLED)
    }
}

// Adapter: framework integration. Domain call -> event publication bridge
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

Benefits of separation:
- Domain models can be unit-tested without a framework
- Domain models do not need to change when the framework changes
- Adapters are boilerplate for receiving commands, calling the domain, and publishing events

### apply/from Pattern: Event Replay

A pattern in which a domain model rebuilds its own state from events.

- `from(event)`: factory that builds initial state from a creation event
- `apply(event)`: returns new state from an event, using immutable updates with `copy()`
- `when` expressions plus sealed interfaces let the compiler guarantee exhaustiveness over event types

```kotlin
fun apply(event: OrderEvent): Order = when (event) {
    is OrderPlacedEvent -> from(event)
    is OrderConfirmedEvent -> copy(status = OrderStatus.CONFIRMED)
    is OrderShippedEvent -> copy(status = OrderStatus.SHIPPED)
    // Because the interface is sealed, adding an event type without handling it is a compile error
}
```

## Event Design

Good events:
```kotlin
// Good: domain intent is clear
OrderPlaced, PaymentReceived, ItemShipped

// Avoid: CRUD style
OrderUpdated, OrderDeleted
```

### Fact Events vs Request Events

Events express facts that occurred, and their names come from business meaning. A `...Requested` suffix or the current number of consumers does not by itself distinguish a fact event from a command in disguise. Accepting or starting a request can be a business fact; a message whose only meaning is instructing a known destination to execute work is a command.

| Comparison axis | Fact event | Consider a command |
|---------------|------------|--------------------|
| Business meaning | An occurrence such as acceptance, start, or rejection that matters to audit or replay | Its only purpose is to make a specific process run |
| Emitter lifecycle | Used by later decisions such as waiting, duplicate rejection, or timeout | The emitter tracks neither state nor outcome |
| Outcome | Continues to another uncertain fact such as completion or failure | Can run immediately within the same boundary and return its result there |
| Consumers | Consumers may change without changing event meaning | Destination and operation are the message's meaning |

Split events by independent business facts, not by technical consumers. Do not emit duplicate state and trigger events for the same occurrence; EventHandlers and projections subscribe to the fact owned by the emitting Aggregate. Multiple events are appropriate only when independently named, audited, and replayed facts occur together. Do not pack another Aggregate's internal state or initialization details into the event; resolve stable IDs or references at the boundary.

```kotlin
// Avoid: One business fact duplicated as separate state and technical trigger events
fun addItem(itemId: String, productId: String, quantity: Int): List<OrderEvent> = listOf(
    OrderItemLinkedEvent(orderId, itemId),                 // for state
    OrderItemCreationRequestedEvent(orderId, itemId, productId, quantity), // for triggering (a command in effect)
)

// Example: A single event carrying the content that is factual for the emitting Aggregate
fun addItem(itemId: String, productId: String, quantity: Int): OrderItemAddedEvent =
    OrderItemAddedEvent(orderId, itemId, productId, quantity)
```

### Event Type Hierarchy with sealed interface

Aggregate events should use a sealed interface type hierarchy. The Aggregate root ID should be required as a common field, enabling exhaustive `when` checks.

```kotlin
sealed interface OrderEvent {
    val orderId: String  // Required on every event
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

Benefits:
- A `when (event)` expression must list every event type, otherwise compilation fails. This is especially important in `apply`
- The compiler guarantees that the Aggregate root ID exists
- Event-handler branching by type is safer

Event granularity:
- Too fine: `OrderFieldChanged` -> domain intent is unclear
- Appropriate: `ShippingAddressChanged` -> intent is clear
- Too coarse: `OrderModified` -> unclear what changed

## Event Evolution

Event evolution separates the current event contract, historical-payload translation, and state restoration through replay. Current event types and domain logic represent only current semantics. When historical payload translation is performed, the event-store restoration boundary converts the payloads before replay.

Responsibilities in event evolution:

| Responsibility | Location |
|----------------|----------|
| Current event meaning and fields | Event type |
| Historical-payload translation, when part of the design | Upcaster at the event-store restoration boundary |
| State restoration from event replay | Aggregate `apply` |
| Behavioral evidence for historical-payload translation | Upcaster tests |

```kotlin
// Current event type
data class OrderAssignedEvent(
    override val orderId: String,
    val assigneeIds: List<String>
) : OrderEvent
```

```kotlin
// Example - Convert a historical payload at the restoration-boundary upcaster
when (eventType) {
    OrderAssignedEvent::class.java.typeName -> {
        event.moveTextFieldToArray("assigneeId", "assigneeIds")
    }
}
```

When historical translation is part of the design, whether old event types remain in application code depends on the framework and migration mechanism. Historical serialized types and payloads can serve as upcaster input contracts without becoming current domain events.

### Migration Responsibility Boundaries

CQRS+ES has distinct responsibility boundaries for DB schema migration, data migration, event upcasters, Read Model rebuilds, and API compatibility work. Each changes a different contract and uses a different execution boundary.

| Migration type | Responsibility boundary |
|----------------|-------------------------|
| Database schema migration | Relational schema changes |
| Data migration / backfill | Relational data transformation |
| Event upcaster | Historical-payload translation during event-store restoration |
| Read Model rebuild | Regeneration of projections derivable from events |
| API compatibility | External consumer contract boundary |

## Command Handlers

### Contract Lifetimes of Commands and Events

Events are long-lived contracts persisted as history. When historical payload translation is performed, keep the current event type identifier and payload contract separate from the boundary that translates historical payloads into replayable form, choosing the translation mechanism from the event store and serialization strategy.

Commands are usually short-lived messages created and handled at the application boundary, but some architectures persist them for scheduling, outbox delivery, retries, dead-letter handling, or audit. Persisted references are impact boundaries to investigate when commands move or are renamed. Domain models should not depend on transport- or framework-specific command types; translate them into domain arguments and value objects at the application or adapter boundary.

Good command handler:
```
1. Receive a command
2. Restore the Aggregate from the event store
3. Apply the command to the Aggregate
4. Store the emitted events
```

### Multi-layer Validation

Validation responsibilities differ by layer. Do not collect every validation in one place.

| Layer | Responsibility | Means | Example |
|-------|----------------|-------|---------|
| API layer | Structural validation | `@NotBlank`, `init` block | Required fields, type, format |
| UseCase layer | Business-rule validation | Querying Read Models | Duplicate checks, existence of prerequisites |
| Domain layer | State-transition invariants | `require` | "Can only approve when PENDING" |

### Aggregate Decision Boundary

Aggregates make decisions only from state restored from their own event history and facts explicitly supplied as commands. They are not the place to interpret, normalize, or verify ownership of boundary-originated input.

Validation inside an Aggregate must be limited to state that can be reproduced solely by event replay. Other validation should be resolved at the boundary before command dispatch, and resolved facts should be passed to the Aggregate.

| Target | Location |
|-----------------|----------|
| Whether the operation is possible in the current state | Aggregate |
| Whether command executor matches Aggregate owner | Aggregate |
| HTTP/API input shape is valid | API layer |
| Interpreting formats of external identifiers such as object keys, URLs, paths | UseCase layer or boundary policy/verifier |
| External identifier belongs to the current user/tenant | UseCase layer or boundary policy/verifier |
| Checking another Aggregate's Read Model or external facts | UseCase layer |
| State-transition decisions based on the same Aggregate's current state | Aggregate |
| Entity exists in an external service | Application-layer external-service integration |

Example: in an upload-completion command, the Aggregate decides whether the session owner matches the executor and whether the current state allows completion. The string shape of the object key and whether that key belongs to the current user/tenant area are verified in the UseCase layer before the command is sent.

### Command Intent and Pre-querying

A Command represents what the user or external process intends to do, not which command should be selected after reading the current state. Decisions such as Add / Update / Delete / Noop based on current state should be pushed into the restored Aggregate, not decided from the same Aggregate's Read Model.

```kotlin
// Avoid: Query result chooses the command type
if (readService.exists(orderId)) {
    commandGateway.send(UpdateOrderCommand(orderId, value))
} else {
    commandGateway.send(AddOrderCommand(orderId, value))
}

// Example: Send an intent command; the Aggregate decides from restored state
commandGateway.send(SetOrderValueCommand(orderId, value))
```

```kotlin
// API layer: structural validation
data class OrderPostRequest(
    @field:NotBlank val customerId: String,
    @field:NotNull val items: List<OrderItemRequest>
) {
    init {
        require(items.isNotEmpty()) { "An order must have at least one item" }
    }
}

// UseCase layer: business-rule validation by Read Model reference
@Service
class PlaceOrderUseCase(
    private val commandGateway: CommandGateway,
    private val customerRepository: CustomerRepository,
    private val inventoryRepository: InventoryRepository
) {
    fun execute(input: PlaceOrderInput): Mono<PlaceOrderOutput> {
        return Mono.fromCallable {
            // Customer existence check
            customerRepository.findById(input.customerId)
                ?: throw CustomerNotFoundException("Customer does not exist")
            // Inventory precheck
            validateInventory(input.items)
            // Command dispatch
            val orderId = UUID.randomUUID().toString()
            commandGateway.send<Any>(PlaceOrderCommand(orderId, input.customerId, input.items))
            PlaceOrderOutput(orderId)
        }
    }
}

// Domain layer: state-transition invariant
fun confirm(confirmedBy: String): OrderConfirmedEvent {
    require(status == OrderStatus.PENDING) { "Cannot confirm in this state" }
    return OrderConfirmedEvent(orderId, confirmedBy, LocalDateTime.now())
}
```

## UseCase Layer: Orchestration

Place a UseCase layer between Controller and CommandGateway. The UseCase layer gathers facts that must be resolved at the boundary and normally sends one intent command. Subsequent state changes are driven by EventHandlers for committed events.

```
Controller -> UseCase -> CommandGateway -> Aggregate
                |
          QueryGateway / Repository (Read Model reference)
```

Cases that need a UseCase:
- Checking another Aggregate's Read Model or external facts before command dispatch
- Running multiple validations sequentially
- Waiting for eventual consistency after command dispatch only for a synchronous API contract

Cases that do not need a UseCase:
- A simple operation where the Controller sends one command and is done
- A simple read where the Controller queries the Query side and converts to a response
- An operation that only checks existence/scope of an existing resource and then sends one command

## Event-driven Chaining

In CQRS+ES, chains of state changes start from committed events. Application Services, UseCases, and Controllers must not synchronously control the order of multiple Aggregate changes by sending commands sequentially for the same state transition.

Basic shape:

```text
UseCase -> Command -> Aggregate -> Event
                              |
                         EventHandler -> Command -> another Aggregate
                              |
                         Projection -> Read Model
```

## Projection Design

Good projections:
- Optimized for a specific read use case
- Rebuildable idempotently from events
- Completely independent from Write Model

### Distinguishing Projections from EventHandlers for Side Effects

Both use `@EventHandler`, but their responsibilities differ. Do not confuse them.

| Type | Responsibility | Does | Does Not Do |
|------|----------------|------|-------------|
| Projection | Read Model update | Save/update Entity | Dispatch commands, call external APIs |
| EventHandler | Side effect | Dispatch commands to other Aggregates | Update Read Models |

```kotlin
// Projection: Read Model update only
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

// EventHandler: side effect, command dispatch to another Aggregate
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

### Starting External Processing

Starting external workers or asynchronous processing should be triggered by a domain event that an Aggregate has committed. An Application Service or Coordinator must not bundle command dispatch and external side effects in the same control flow for the same state transition.

## Query-side Design

The Query side operates as an event-driven PubSub model. Projections update Read Models with EventHandlers, and the Query side references those Read Models.

Event delivery should be PubSub, through a message broker, to all instances. Do not rely on mechanisms that deliver only to the same instance unless delivery guarantees are confirmed.

- **Subscription Query** (for example Axon's `subscriptionQuery()`): a mechanism that returns change notifications for query results to the subscriber. Use it only when it is already adopted as infrastructure and delivery to subscribers is guaranteed. In systems based on tracking processors or trackers, do not introduce subscription query only for a feature implementation.
- **Subscribing event processor** (for example Axon's `SubscribingEventProcessor`): depends on direct subscription from the local event bus, so only the instance that published the event receives it. In distributed environments, projections on other instances are not updated. Configure PubSub delivery to all instances.

### QueryHandler and ApplicationService Naming

In CQRS, the component that receives queries is called a QueryHandler, and the entry point that sends queries is treated as QueryGateway / QueryBus. A facade called from a Controller to coordinate read use cases should be named ApplicationService or ReadService so it is not confused with QueryHandler.

Types between layers:
- `application/query/` - query-result type, for example `OrderDetail`
- `adapter/protocol/` - REST response type, for example `OrderDetailResponse`
- QueryHandler returns application-layer types; Controller converts them to adapter-layer types

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

// QueryHandler - returns application-layer type
@QueryHandler
fun handle(query: GetOrderDetailQuery): OrderDetail? {
    val entity = repository.findById(query.id) ?: return null
    return OrderDetail(...)
}

// Controller - simple reference can return synchronously
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
Controller (adapter) -> QueryGateway -> QueryHandler (application) -> Repository
     |                                      |
Response.from(detail)                  OrderDetail

Event flow (PubSub):
Aggregate -> Event Bus -> Projection(@EventHandler) -> Repository(Read Model)
                                                          ^
                                          QueryHandler references this
```

### Asynchronous Callbacks and Concurrency Control

Design asynchronous completion callbacks assuming duplicates, delays, and ordering inversions. Protect with Aggregate state transitions and command idempotency, not Controller or single-process locks.

## Eventual Consistency

Wait for Projection updates after command dispatch only when there is an explicit synchronous contract to return the updated Read Model in the same API response. If the client can keep the input values or generated ID, the server should not wait; Read Model convergence is handled through normal read APIs.

### Reactive Polling

Reactive polling is the pattern of dispatching a command and then waiting non-blockingly for Projection update completion. It does not occupy a request thread and is not a synchronous `while` loop with `Thread.sleep`.

The polling condition should be checked by re-fetching the Read Model and testing whether it has reached the expected state, not by event notifications. Re-fetch at a fixed interval until the condition is met, timeout occurs, or max attempts are reached.

```kotlin
// UseCase: command dispatch -> wait for completion with polling
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
// Avoid: Occupies request threads and causes thread starvation under load
while (Instant.now().isBefore(deadline)) {
    val order = orderRepository.findById(orderId).orElse(null)
    if (order?.status == OrderStatus.CONFIRMED) return PlaceOrderOutput(orderId)
    Thread.sleep(100)
}

// Example: If the same response must wait, put it on reactive waiting
return pollForCompletion(orderId).thenReturn(PlaceOrderOutput(orderId))
```

Cases where polling is appropriate:
- The response should not return until Saga completion
- The command dispatch creates a resource ID and the response needs to return it

Cases where polling is unnecessary:
- A simple operation where command dispatch alone completes the work and the result is not waited on
- The UI does not need real-time update

If the server does not wait, return `202 Accepted` with a tracking ID after accepting the command, and let the frontend use long polling or normal polling on the read API. SSE or WebSocket can also be considered if the user experience requires immediacy.

## Saga vs EventHandler

Use Saga only for operations involving contention between multiple Aggregates.

Cases that need Saga:
```
Multiple actors compete for the same resource
Example: inventory reservation, where 10 people order the same product at the same time

OrderPlacedEvent
  -> InventoryReservationSaga
ReserveInventoryCommand -> Inventory Aggregate (serializes concurrency)
  ->
InventoryReservedEvent -> ConfirmOrderCommand
InventoryReservationFailedEvent -> CancelOrderCommand
```

Cases that do not need Saga:
```
Operation with no contention
Example: releasing inventory on order cancellation

OrderCancelledEvent
  -> InventoryReleaseHandler (simple EventHandler)
ReleaseInventoryCommand
  ->
InventoryReleasedEvent
```

Decision criteria:

| Situation | Saga | EventHandler |
|-----------|------|--------------|
| Resource contention exists | Use | - |
| Compensation transaction is needed | Use | - |
| Simple integration with no contention | - | Use |
| Retry is enough on failure | - | Use |

Anti-pattern:
```kotlin
// Avoid: Using Saga for lifecycle management
@Saga
class OrderLifecycleSaga {
    // Tracks every order state transition
    // PLACED -> CONFIRMED -> SHIPPED -> DELIVERED
}

// Example: Saga only for operations that need eventual consistency
@Saga
class InventoryReservationSaga {
    // Concurrency control for inventory reservation only
}
```

Saga is not a lifecycle-management tool. Create it for an operation that needs eventual consistency.

## Exception vs Event: Failure Choice

Failures that do not require audit are exceptions; failures that require audit are events.

Exception approach, recommended in most cases:
```kotlin
// Domain model: throw an exception on validation failure
fun reserveInventory(orderId: String, quantity: Int): InventoryReservedEvent {
    if (availableQuantity < quantity) {
        throw InsufficientInventoryException("Insufficient inventory")
    }
    return InventoryReservedEvent(productId, orderId, quantity)
}

// Saga: catch with exceptionally and issue compensation action
commandGateway.send<Any>(command)
    .exceptionally { ex ->
        commandGateway.send<Any>(CancelOrderCommand(
            orderId = orderId,
            reason = ex.cause?.message ?: "Inventory reservation failed"
        ))
        null
    }
```

Event approach, rare cases:
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
| Does this failure need to be reviewed later? | No | Yes |
| Is a record required by regulation or compliance? | No | Yes |
| Is only the Saga interested in the failure? | Yes | No |
| Is there value in storing it in the Event Store? | No | Yes |

Default to the exception approach. Consider events only when there is an audit requirement.

## Abstraction-level Evaluation

**Conditionals and abstraction**

Do not choose Strategy, State, or polymorphism from branch count alone. When two implementations with the same domain meaning, contract, and reason to change are observed, decide whether they belong under the proper owner such as the Aggregate, EventHandler, or Projection. Keep behavior separate when event types or states change for different reasons.

**Detecting mismatched abstraction levels**

| Pattern | Problem | Fix |
|---------|---------|-----|
| DB operation details in CommandHandler | Responsibility violation | Separate into Repository layer |
| Business logic in EventHandler | Responsibility violation | Extract to domain service |
| Persistence processing in Aggregate | Layer violation | Move behind EventStore |
| Calculation logic in Projection | Hard to maintain | Extract to dedicated service |

Good abstraction examples:

```kotlin
// Event-type branching grows repeatedly (NG)
@EventHandler
fun on(event: DomainEvent) {
    when (event) {
        is OrderPlacedEvent -> handleOrderPlaced(event)
        is OrderConfirmedEvent -> handleOrderConfirmed(event)
        is OrderShippedEvent -> handleOrderShipped(event)
        // ...keeps growing
    }
}

// Split by event (OK)
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
        // ...complexity grows
    }
}

// State Pattern (OK)
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

## Anti-pattern observations

In CQRS+ES, inspect implementations that only mimic CRUD, emit meaningless events repeatedly, depend implicitly on event order, omit important facts, or concentrate all responsibilities in one Aggregate.

## Test Strategy

Separate test strategy by layer.

Test pyramid:
```
        +-------------+
        |   E2E Test  |  <- Few: full-flow confirmation
        +-------------+
        | Integration |  <- Command -> Event -> Projection -> Query integration
        +-------------+
        |  Unit Test  |  <- Many: each layer isolated
        +-------------+
```

Command side (Aggregate):
```kotlin
// Using AggregateTestFixture
@Test
fun `confirmation command emits event`() {
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
fun `order detail is returned`() {
    // Given: set up Read Model directly
    orderRepository.save(OrderEntity(...))

    // When: execute query through QueryGateway
    val detail = queryGateway.query(GetOrderDetailQuery(orderId), ...).join()

    // Then
    assertEquals(expectedDetail, detail)
}
```

## Value Object Design

Use value objects as Aggregate and event components. Do not rely only on primitive types such as String or Int.

```kotlin
// Avoid: primitives only
data class OrderPlacedEvent(
    val orderId: String,
    val categoryId: String,      // Just a string
    val from: LocalDateTime,     // Meaning is unclear
    val to: LocalDateTime
)

// Example: Value objects express meaning and constraints
data class OrderPlacedEvent(
    val orderId: String,
    val categoryId: CategoryId,
    val period: OrderPeriod
)
```

Value object design rules:
- Use `data class` to auto-generate equals/hashCode, comparing by value
- Guarantee invariants in `init` blocks, validating at creation
- Do not include domain logic such as state transitions; keep them as pure data holders
- Use `@JsonValue` to control serialization

```kotlin
// ID type: single-value wrapper
data class CategoryId(@get:JsonValue val value: String) {
    init {
        require(value.isNotBlank()) { "Category ID cannot be blank" }
    }
    override fun toString(): String = value
}

// Range type: invariant over multiple values
data class OrderPeriod(
    val from: LocalDateTime,
    val to: LocalDateTime
) {
    init {
        require(!to.isBefore(from)) { "End date must be on or after start date" }
    }
}

// Metadata type: associated data in event payload
data class ApprovalInfo(
    val approvedBy: String,
    val approvalTime: LocalDateTime
)
```

## Master Data, Settings, and CRUD Use

Even inside a CQRS+ES system, not everything needs to be event-sourced. Simple master data, reference data, managed settings, and allowlists are often simpler and easier to maintain as normal CRUD.

Do not mechanically decide "master data means CRUD". The more the following criteria apply, the more suitable CRUD is. Conversely, if explicit requirements match CQRS+ES adoption criteria, consider CQRS+ES.

**Criteria for deciding CRUD is enough:**

| Perspective | CRUD-leaning | CQRS+ES-leaning |
|-------------|--------------|-----------------|
| Business requirement | Around "manage X" with no special mention | Specific business rules or constraints exist |
| Logic evolution | Simple reference/update completes it, unlikely to evolve | State transitions or lifecycle can become complex |
| Change history/audit | No need to track who changed what and when | Need change-history reference or audit evidence |
| Domain events | This change does not affect other Aggregates or processes | Change triggers downstream processes |
| Consistency scope | Self-contained, no need for consistency with other Aggregates | Needs consistency with other Aggregates |
| Point-in-time reference | No question asks for "state at a past point" | Point-in-time queries are needed |

**Typical CRUD targets:**
- Prefecture and country-code master data
- Category and tag classification master data
- Settings and constant tables
- Current-value managed settings such as IP allowlists, feature flags, and notification settings

**Examples where CQRS+ES can be justified:**
- Product master data where price-change history must be tracked
- Organization master data where changes trigger permission recalculation
- Customer/vendor master data with credit-review state transitions

```kotlin
// CRUD is enough: simple category master
@Entity
data class Category(
    @Id val categoryId: String,
    val name: String,
    val displayOrder: Int
)

// CQRS+ES is appropriate: product requiring price-change history
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

When implementing with CRUD, other Aggregates in a CQRS+ES system should still reference it by ID. It is the same principle that CRUD entities must not directly reference Aggregate internal state.

## Infrastructure Layer

Checklist:
- Is the event-store choice appropriate?
- Does the messaging infrastructure satisfy requirements?
- Is the snapshot strategy defined?
- Is the event serialization format appropriate?
