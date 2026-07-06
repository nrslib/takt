# CQRS+ES Knowledge

## CQRS+ES Adoption Decision

CQRS+ES is a design in which state changes are stored as domain events, and current state and Read Models are derived from them. Even when the backend as a whole or the workflow handles CQRS+ES, not every new feature needs to be implemented with event sourcing.

| Criteria | Judgment |
|----------|----------|
| User request, design material, or existing boundaries explicitly require CQRS+ES | Adopt CQRS+ES |
| State transitions, lifecycle, and business invariants are central to the feature | Consider CQRS+ES |
| Change events trigger other Aggregates, Sagas, or downstream processes | Consider CQRS+ES |
| Restoring state at a past point, event replay, or audit evidence itself is a requirement | Consider CQRS+ES |
| Read Models need to be projected asynchronously for multiple uses | Consider CQRS+ES |
| The feature is complete with current-value reference and updates only | Prefer CRUD |
| Security settings, feature flags, allowlists, thresholds, or similar values require immediate reflection | Prefer CRUD |
| There is no domain vocabulary beyond "create/update/delete" | Prefer CRUD |
| The task is merely being implemented in a CQRS+ES workflow | Do not use as adoption rationale |
| Adding CQRS+ES requirements to a task specification when they were absent from the original task | REJECT |

Adopt CQRS+ES based on requirements. An existing system containing CQRS+ES can justify aligning dependencies and boundaries, but it does not justify event-sourcing simple settings tables.

### Requirement Transformation

If the original task or user request states only CRUD-equivalent business requirements, do not add "commands, events, and projections" as new requirements in the task specification. If it is unclear whether CQRS+ES is needed, state the adoption rationale or leave it as an open question.

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

| Criteria | Judgment |
|----------|----------|
| Aggregate spans multiple transaction boundaries | REJECT |
| Direct references between Aggregates, not ID references | REJECT |
| Aggregate exceeds 100 lines | Consider splitting |
| Business invariants exist outside the Aggregate | REJECT |
| Holding fields not used for decisions | REJECT |
| Branching state transitions with origin metadata such as `source` / `input` / `origin` / `channel` / `type` | REJECT by default |
| Rejecting, only for a specific input source, a state allowed by the existing Aggregate's normal lifecycle | REJECT |

Being used in an `if` / `require` branch is not enough to justify keeping a field in Aggregate state. First verify that the branch or validation is an essential invariant of the whole Aggregate.

### Origin Metadata and Invariants

Origin metadata such as input source, channel, producer, or integration source can be needed for display, search, audit, or integration tracing. That need alone does not justify restoring it as Aggregate state.

| Criteria | Judgment |
|----------|----------|
| Origin metadata is needed only for display, search, audit, or integration tracing | Keep it in the Event payload or Read Model |
| A branch based on origin metadata creates constraints that differ from the existing Aggregate's normal lifecycle | REJECT |
| A field that is normally optional becomes required only for one input source | REJECT |
| Invariants truly differ by input source | Consider a separate Aggregate, Command, or UseCase boundary |
| Adding origin metadata to Aggregate state only to support a `require` | REJECT |

```kotlin
// NG - Origin metadata narrows the normal lifecycle of an existing Aggregate
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

// OK - Track origin in events/read models and align Aggregate invariants with the normal lifecycle
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

| Criteria | Judgment |
|----------|----------|
| Business logic such as validation inside `apply` | REJECT. `apply` is state restoration only |
| `apply` has side effects such as DB operations or event emission | REJECT |
| `apply` throws exceptions | REJECT. Replay failures are not acceptable |

## Event Design

| Criteria | Judgment |
|----------|----------|
| Event is not in past tense, such as Created -> Create | REJECT |
| Event contains logic | REJECT |
| Event contains internal state of another Aggregate | REJECT |
| Event schema is not versioned | Warning |
| CRUD-style events such as Updated or Deleted | Needs review |

Good events:
```kotlin
// Good: domain intent is clear
OrderPlaced, PaymentReceived, ItemShipped

// Bad: CRUD style
OrderUpdated, OrderDeleted
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

Events are persisted contracts. If the current event type changes, old events must still be replayable. Translating old events belongs in the upcaster / migration layer at the event-store restoration boundary, not in event classes or domain logic.

| Criteria | Judgment |
|----------|----------|
| Persisted event type or fields changed without a translation path | REJECT |
| Current event type keeps old field aliases or compatibility-only properties | REJECT. Keep history compatibility in upcasters |
| Aggregate or `apply` directly interprets old event shapes | REJECT. Convert to current events before replay |
| Event adds "previous value" only for compatibility | REJECT. Events represent the fact after it happened |
| Upcaster converts old payloads into current event meaning | OK |
| Tests verify conversion from old payloads to current events | OK |

Responsibilities in event evolution:

| Responsibility | Location |
|----------------|----------|
| Current event meaning and fields | Event type |
| Reading old payloads | Upcaster / migration layer |
| State restoration from event replay | Aggregate `apply` |
| Guarantee that old events can be converted to current events | Upcaster tests |

```kotlin
// NG - Mixing old field compatibility into the current event type
data class OrderAssignedEvent(
    val orderId: String,
    @JsonAlias("assigneeId")
    val assigneeIds: List<String>
)

// OK - Current event type represents only the current contract
data class OrderAssignedEvent(
    val orderId: String,
    val assigneeIds: List<String>
)
```

```kotlin
// OK - Convert old payloads to current payloads in an upcaster
when (eventType) {
    OrderAssignedEvent::class.java.typeName -> {
        event.moveTextFieldToArray("assigneeId", "assigneeIds")
    }
}
```

Whether to keep old event types in application code depends on the framework and operational policy. In general, it is better not to treat old types as normal domain events. Instead, test the old serialized type and payload as input contracts for the upcaster, keeping the current model clean.

## Command Handlers

| Criteria | Judgment |
|----------|----------|
| Handler directly manipulates the DB | REJECT |
| Handler changes multiple Aggregates | REJECT |
| Command has no validation | REJECT |
| Handler executes queries to make decisions | Needs review |

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

| Decision Target | Location |
|-----------------|----------|
| Whether the operation is possible in the current state | Aggregate |
| Whether command executor matches Aggregate owner | Aggregate |
| HTTP/API input shape is valid | API layer |
| Interpreting formats of external identifiers such as object keys, URLs, paths | UseCase layer or boundary policy/verifier |
| External identifier belongs to the current user/tenant | UseCase layer or boundary policy/verifier |
| Read Model or other Aggregate state checks | UseCase layer |
| Entity exists in an external service | Application-layer external-service integration |

Example: in an upload-completion command, the Aggregate decides whether the session owner matches the executor and whether the current state allows completion. The string shape of the object key and whether that key belongs to the current user/tenant area are verified in the UseCase layer before the command is sent.

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

| Criteria | Judgment |
|----------|----------|
| Domain-layer validation exists in API layer | REJECT. State-transition rules belong in the domain |
| UseCase-layer validation exists in Controller | REJECT. Separate into UseCase layer |
| API-layer validation such as `@NotBlank` exists in domain | REJECT. Structural validation belongs in API layer |

## UseCase Layer: Orchestration

Place a UseCase layer between Controller and CommandGateway. Before command dispatch, it validates by referring to Read Models from multiple Aggregates and performs necessary preprocessing.

```
Controller -> UseCase -> CommandGateway -> Aggregate
                |
          QueryGateway / Repository (Read Model reference)
```

Cases that need a UseCase:
- Checking another Aggregate's state from a Read Model before command dispatch
- Running multiple validations sequentially
- Waiting for eventual consistency after command dispatch, using reactive polling

Cases that do not need a UseCase:
- A simple operation where the Controller sends one command and is done
- A simple read where the Controller queries the Query side and converts to a response
- An operation that only checks existence/scope of an existing resource and then sends one command

| Criteria | Judgment |
|----------|----------|
| Controller directly references Repository for validation | Separate into UseCase layer |
| UseCase depends on HTTP request/response | REJECT. UseCase must be protocol-independent |
| UseCase directly changes Aggregate internal state | REJECT. Use CommandGateway |
| UseCase waits for results with Subscription Query whose delivery is guaranteed by Axon Server or similar | OK |
| UseCase waits for results with Subscription Query whose delivery guarantee is unknown | REJECT. Use reactive polling |
| UseCase only thinly delegates to another query layer or command dispatch | Consider removing |

## Projection Design

| Criteria | Judgment |
|----------|----------|
| Projection dispatches commands | REJECT |
| Projection references Write Model | REJECT |
| One projection supports multiple use cases | Needs review |
| Cannot be rebuilt | REJECT |

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

| Criteria | Judgment |
|----------|----------|
| Projection uses CommandGateway | REJECT. Separate into EventHandler |
| EventHandler saves with Repository | REJECT. Separate into Projection |
| One class mixes Projection and EventHandler responsibilities | REJECT. Split classes |

### Starting External Processing

Starting external workers or asynchronous processing should be triggered by a domain event that an Aggregate has committed. An Application Service or Coordinator must not bundle command dispatch and external side effects in the same control flow for the same state transition.

| Criteria | Judgment |
|----------|----------|
| Application Service or Coordinator starts external processing immediately after command dispatch for the same state transition | REJECT. Separate into EventHandler for committed events |
| Aggregate emits an event that represents generation start or processing start, and EventHandler starts external processing | OK |
| EventHandler reports external-processing start failure back to the Aggregate with a failure command | OK |
| Input needed for external processing is represented by the event or stable IDs that can be reloaded | OK |
| External-processing input exists only in local variables during command processing | REJECT. Move to events or reloadable references |
| Saga is used for simple external processing with no contention or compensation | REJECT. EventHandler is enough |

## Query-side Design

The Query side operates as an event-driven PubSub model. Projections update Read Models with EventHandlers, and the Query side references those Read Models.

Event delivery should be PubSub, through a message broker, to all instances. Do not rely on mechanisms that deliver only to the same instance unless delivery guarantees are confirmed.

- **Subscription Query** (for example Axon's `subscriptionQuery()`): a mechanism that returns change notifications for query results to the subscriber. It can be used when delivery to subscribers is guaranteed by a configuration such as Axon Server. If the destination is not guaranteed in distributed deployment or with third-party event-store plugins, use reactive polling to wait for Read Model updates when a synchronous response is required.
- **Subscribing event processor** (for example Axon's `SubscribingEventProcessor`): depends on direct subscription from the local event bus, so only the instance that published the event receives it. In distributed environments, projections on other instances are not updated. Configure PubSub delivery to all instances.

| Criteria | Judgment |
|----------|----------|
| Use of Subscription Query with confirmed delivery guarantee, such as Axon Server `subscriptionQuery()` | OK |
| Use of Subscription Query with unknown delivery guarantee, such as Axon `subscriptionQuery()` | REJECT. Use reactive polling |
| Use of Subscribing event processor, such as Axon `SubscribingEventProcessor` | REJECT. Local delivery only; other instances are not updated in distributed environments |
| Controller directly references Repository | REJECT. Go through UseCase layer |
| Query side references Command Model | REJECT |
| QueryHandler dispatches commands | REJECT |
| Query-side service or handler saves, deletes, or calls external APIs | REJECT |
| Command and Query are mixed in the same service | REJECT. Separate responsibilities and naming |
| Query side performs existence/scope checks and the caller dispatches a command | OK |

### QueryHandler and ApplicationService Naming

In CQRS, the component that receives queries is called a QueryHandler, and the entry point that sends queries is treated as QueryGateway / QueryBus. A facade called from a Controller to coordinate read use cases should be named ApplicationService or ReadService so it is not confused with QueryHandler.

| Criteria | Judgment |
|----------|----------|
| Receives a Query, references Read Model, and returns a query-result type | QueryHandler |
| Coordinates multiple Queries, authorization boundary, paging, and DTO assembly from Controller | ApplicationService or ReadService |
| A class that only sends queries or coordinates reads is called QueryService | Warning. Easy to confuse with QueryHandler |
| QueryHandler knows HTTP request/response or Controller-specific error conversion | REJECT |
| Adds a simple read wrapper with no additional decision | Consider removing. Controller may call QueryGateway directly |

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

| Criteria | Judgment |
|----------|----------|
| Prevent duplicate callbacks with Controller or application-process locks | REJECT. Does not work across instances |
| Determine processing state from Aggregate state | OK |
| Aggregate verifies callback attempt ID or generation | OK |
| Idempotently ignore old or duplicate callbacks by state transition | OK |
| Concurrency control is duplicated across Controller, UseCase, and Aggregate | REJECT |

## Eventual Consistency

When a synchronous response is required after command dispatch, and no event notification can be guaranteed to reach the waiting process, wait for Projection updates with reactive polling.

| Criteria | Judgment |
|----------|----------|
| There is infrastructure guaranteeing Projection update notification delivery to the waiting process | OK. Notification-driven waiting is acceptable |
| Configuration such as Axon Server Subscription Query confirms update notifications reach subscribers | OK |
| Kafka or similar guarantees destination, redelivery, and missing-message handling operationally | OK |
| Subscription Query or event notification destination assumes single process/single instance, or guarantee is unknown | REJECT. Use reactive polling |
| `Thread.sleep` or equivalent blocks request threads while waiting for Projection updates | REJECT. Causes thread starvation under high concurrency |
| Updated state must be returned in the same HTTP response | Wait non-blockingly on a reactive HTTP stack |
| Same response does not need to wait | `202 Accepted` plus frontend long polling, normal polling, SSE, or WebSocket |
| UI expects immediate update | Frontend polling, SSE, WebSocket, or server-side reactive waiting |
| Consistency delay exceeds acceptable range | Reconsider architecture |
| Compensation transaction is undefined | Require failure-scenario review |

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
// NG - Occupies request threads and causes thread starvation under load
while (Instant.now().isBefore(deadline)) {
    val order = orderRepository.findById(orderId).orElse(null)
    if (order?.status == OrderStatus.CONFIRMED) return PlaceOrderOutput(orderId)
    Thread.sleep(100)
}

// OK - If the same response must wait, put it on reactive waiting
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
// NG - Using Saga for lifecycle management
@Saga
class OrderLifecycleSaga {
    // Tracks every order state transition
    // PLACED -> CONFIRMED -> SHIPPED -> DELIVERED
}

// OK - Saga only for operations that need eventual consistency
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

**Detecting bloated conditional branches**

| Pattern | Judgment |
|---------|----------|
| Same if-else pattern appears in 3 or more places | Abstract with polymorphism -> REJECT |
| switch/case has 5 or more branches | Consider Strategy/Map pattern |
| Branching by event type grows repeatedly | Split EventHandlers -> REJECT |
| State branching inside Aggregate is complex | Consider State Pattern |

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

## Anti-pattern Detection

Reject when any of the following is found:

| Anti-pattern | Problem |
|--------------|---------|
| CRUD disguise | Only mimics the shape of CQRS while implementing CRUD |
| Anemic Domain Model | Aggregate is only a data structure |
| Event Soup | Meaningless events are emitted repeatedly |
| Temporal Coupling | Implicit dependency on event order |
| Missing Events | Important domain events are missing |
| God Aggregate | One Aggregate concentrates all responsibilities |

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

Checklist:

| Perspective | Judgment |
|-------------|----------|
| Aggregate tests verify events, not state | Required |
| Query-side tests do not create data through commands | Recommended |
| Integration tests account for Axon asynchronous processing | Required |

## Value Object Design

Use value objects as Aggregate and event components. Do not rely only on primitive types such as String or Int.

```kotlin
// NG - primitives only
data class OrderPlacedEvent(
    val orderId: String,
    val categoryId: String,      // Just a string
    val from: LocalDateTime,     // Meaning is unclear
    val to: LocalDateTime
)

// OK - Value objects express meaning and constraints
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

| Criteria | Judgment |
|----------|----------|
| Reusing IDs as raw String | Consider value object |
| Same field combination, such as from/to, appears in multiple places | Extract value object |
| Value object contains business logic such as state transitions | REJECT. Aggregate responsibility |
| No `init` block to guarantee invariants | REJECT |

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
