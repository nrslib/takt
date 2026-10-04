# CQRS+ES Policy

Keep adoption, boundaries, state transitions, and event chaining for CQRS+ES under one source of truth for independent judgments.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Derive adoption from requirements | Do not add CQRS+ES requirements that are absent from the original requirements, design, or existing boundaries |
| Limit Aggregate responsibility | Keep state transitions and invariants in the Aggregate; do not import Read Model or another Aggregate's internal state |
| Treat events as facts | Record business facts in past tense; do not name events with verb-base or imperative forms such as `Create` or `OpenAccount`, and do not duplicate technical trigger events |
| Keep replay pure | `apply` only restores state; it does not validate, throw, or perform side effects |
| Preserve command intent | Do not choose command types from a Read Model's current value; let the restored Aggregate decide |
| Start chains from events | Do not send commands sequentially for one state transition; start EventHandlers from committed events |
| Preserve Read/Write boundaries | Projections update Read Models; the Query side does not issue commands or use the Write Model |
| Separate side-effect owners | Do not mix Projection, EventHandler, and external-processing responsibilities |

## CQRS+ES Adoption

| Criterion | Judgment |
|-----------|----------|
| User request, design material, or existing boundaries explicitly require CQRS+ES | Adopt CQRS+ES |
| State transitions, lifecycle, and business invariants are central to the feature | Consider CQRS+ES |
| Change events trigger other Aggregates, Sagas, or downstream processes | Consider CQRS+ES |
| Restoring state at a past point, event replay, or audit evidence itself is a requirement | Consider CQRS+ES |
| Read Models need to be projected asynchronously for multiple uses | Consider CQRS+ES |
| The feature is complete with current-value reference and updates only | Prefer CRUD |
| Security settings, feature flags, allowlists, thresholds, or similar values require immediate reflection | Prefer CRUD |
| There is no domain vocabulary beyond “create/update/delete” | Prefer CRUD |
| The task is merely being implemented in a CQRS+ES workflow | Do not use as adoption rationale |
| Adding CQRS+ES requirements absent from the original requirements | REJECT |

## Aggregate Design

| Criterion | Judgment |
|-----------|----------|
| Aggregate spans multiple transaction boundaries | REJECT |
| Direct references between Aggregates, not ID references | REJECT |
| Business invariants exist outside the Aggregate | REJECT |
| Holding fields not used for decisions | REJECT |
| Branching state transitions with origin metadata such as `source` / `input` / `origin` / `channel` / `type` | REJECT by default |
| Rejecting, only for a specific input source, a state allowed by the existing Aggregate's normal lifecycle | REJECT |
| Keeping the creation-time caller in Aggregate state and reusing it as the actor of later events | REJECT. Pass the performer with each command |
| Origin metadata is needed only for display, search, audit, or integration tracing | Keep it in the Event payload or Read Model |
| A branch based on origin metadata creates constraints that differ from the existing Aggregate's normal lifecycle | REJECT |
| A field that is normally optional becomes required only for one input source | REJECT |
| Invariants truly differ by input source | Consider a separate Aggregate, Command, or UseCase boundary |
| Adding origin metadata to Aggregate state only to support a `require` | REJECT |
| The existing Aggregate's normal command / event can represent the same fact | Use the existing lifecycle |
| An input-source-specific wrapper only thinly delegates to a normal command | REJECT |
| An input-source-specific command adds stricter required fields than the normal lifecycle | REJECT |
| Existing Aggregate deletion or update events can trigger derived processing | Separate into EventHandler |
| Display or search fields needed only by a specialized flow | Keep them in the Read Model |
| State transitions or invariants truly differ by input source | Consider a separate Aggregate / bounded context |

## Event Replay

| Criterion | Judgment |
|-----------|----------|
| Business logic such as validation inside `apply` | REJECT. `apply` is state restoration only |
| `apply` has side effects such as DB operations or event emission | REJECT |
| `apply` throws exceptions | REJECT. Replay failures are not acceptable |

## Event Design

| Criterion | Judgment |
|-----------|----------|
| Event is not in past tense, such as Created -> Create | REJECT |
| Event contains logic | REJECT |
| Event contains internal state of another Aggregate | REJECT |
| Event schema is not versioned | Warning |
| CRUD-style events such as Updated or Deleted | Needs review |
| Classifying a message as an event or command from its suffix or current consumer count alone | REJECT. Judge business meaning and lifecycle |
| Splitting the same business fact into a state event (Linked, etc.) and a trigger event (Requested, etc.) | REJECT. Merge them into the fact owned by the emitting Aggregate |
| An asynchronous request to an external service or another context where acceptance or waiting is a business fact and completion/failure is tracked | OK. It can be expressed as the fact that the request was accepted |
| Adding a dedicated request event for processing that an existing fact event (confirmed, approved, etc.) can drive | REJECT. Have an EventHandler, and a domain policy when needed, subscribe to the existing fact |
| Recording an occurrence that only changes another Aggregate's state as an event in one's own stream | REJECT. Facts belong to the stream of the Aggregate where they happened |
| Routing an operation unrelated to an Aggregate's own state or lifecycle through it and relaying it to the target Aggregate | REJECT. Send the command to the target Aggregate and perform checks at the boundary that owns the invariant |

## Command Handlers

| Criterion | Judgment |
|-----------|----------|
| Handler directly manipulates the DB | REJECT |
| Handler changes multiple Aggregates | REJECT |
| Command has no validation | REJECT |
| Handler executes queries to make decisions | Needs review |
| The return contract does not match the number of events an operation can produce | Needs review. Choose a single, optional, collection, or result type from domain cardinality and language/framework conventions |
| A domain model directly receives a transport- or framework-specific command type | REJECT. Translate it into domain input at the application or adapter boundary |
| An application message unused by domain classes sits in the domain package | Move it to the application boundary |
| A command package moves or is renamed | Check scheduling, outbox, retry, dead-letter, and audit storage as impact targets |

## Command Intent and Validation Boundaries

| Criterion | Judgment |
|-----------|----------|
| Check existence or scope of other Aggregates or external facts, then pass resolved facts to the command | OK |
| Read the same Aggregate's Read Model to choose the command type | REJECT |
| The UseCase decides “update if it exists, add if it does not” from Query results | REJECT. Send an intent command such as Set / Attach / Upsert to the Aggregate |
| Aggregate or AggregateAdapter decides existence and transition validity from restored state | OK |
| EventHandler or UseCase suppresses duplicate commands with a pre-query even though the Aggregate could ignore them idempotently | REJECT. Protect with Aggregate state transitions |
| Domain-layer validation exists in API layer | REJECT. State-transition rules belong in the domain |
| UseCase-layer validation exists in Controller | REJECT. Separate into UseCase layer |
| API-layer validation such as `@NotBlank` exists in domain | REJECT. Structural validation belongs in API layer |

## UseCase and Event-driven Chaining

| Criterion | Judgment |
|-----------|----------|
| Controller directly references Repository for validation | Separate into UseCase layer |
| UseCase depends on HTTP request/response | REJECT. UseCase must be protocol-independent |
| UseCase directly changes Aggregate internal state | REJECT. Use CommandGateway |
| UseCase sends multiple commands sequentially for the same state transition | REJECT. Separate into EventHandlers for committed events |
| UseCase queries the same Aggregate's state to choose the command type | REJECT. Push the decision into the Aggregate |
| UseCase validates another Aggregate or external facts and passes resolved facts to one command | OK |
| EventHandler receives a committed event and sends a command to another Aggregate | OK |
| processStore / ProcessStore / operationProcess / completeStep stores projection completion or procedural progress | REJECT. Model it with Projection and EventHandlers |
| There is an explicit long-running business process, retry, compensation, or user-visible progress | Consider Saga / Process Manager |
| UseCase only thinly delegates to another query layer or command dispatch | Consider removing |
| UseCase sends command B immediately after command A for the same state transition | REJECT. Let an EventHandler receive A's event and send B |
| Another command is sent after `sendAndWait` returns to create consistency | REJECT. Separate into event chaining |
| A normal event from an existing Aggregate becomes the trigger for derived processing | OK |
| EventHandler receives a committed event and sends an idempotent command to another Aggregate | OK |
| Projection update and next-command dispatch are mixed in the same handler | REJECT. Separate Projection from EventHandler |
| There is contention, compensation, long-running retry, or user-visible progress | Consider Saga / Process Manager |
| processStore is created only to remember intermediate progress | REJECT. Split responsibilities into Aggregate events, Projections, or Saga |

## Projection and External Processing

| Criterion | Judgment |
|-----------|----------|
| Projection dispatches commands | REJECT |
| Projection references Write Model | REJECT |
| One projection supports multiple use cases | Needs review |
| Projection cannot be rebuilt | REJECT |
| Projection uses CommandGateway | REJECT. Separate into EventHandler |
| EventHandler saves with Repository | REJECT. Separate into Projection |
| One class mixes Projection and EventHandler responsibilities | REJECT. Split classes |
| Application Service or Coordinator starts external processing immediately after command dispatch for the same state transition | REJECT. Separate into EventHandler for committed events |
| Aggregate emits an event that represents generation start or processing start, and EventHandler starts external processing | OK |
| EventHandler reports external-processing start failure back to the Aggregate with a failure command | OK |
| Input needed for external processing is represented by the event or stable IDs that can be reloaded | OK |
| External-processing input exists only in local variables during command processing | REJECT. Move to events or reloadable references |
| Saga is used for simple external processing with no contention or compensation | REJECT. EventHandler is enough |

## Query-side Design and Concurrency

| Criterion | Judgment |
|-----------|----------|
| Use of an existing Subscription Query infrastructure with confirmed delivery guarantee | OK |
| Introducing Subscription Query only for a feature implementation | REJECT. Use the existing tracker / Read Model polling |
| Use of Subscription Query with unknown delivery guarantee | REJECT. Use the existing tracker / Read Model polling |
| Use of a Subscribing event processor | REJECT. Local delivery only; other instances are not updated in distributed environments |
| Controller directly references Repository | REJECT. Go through UseCase layer |
| Query side references Command Model | REJECT |
| QueryHandler dispatches commands | REJECT |
| Query-side service or handler saves, deletes, or calls external APIs | REJECT |
| Command and Query are mixed in the same service | REJECT. Separate responsibilities and naming |
| Query side or ReadService reads Query results to choose the command type for the same Aggregate | REJECT |
| Query side checks existence/scope of another Aggregate or external facts, and the caller dispatches one command | OK |
| A class that only sends queries or coordinates reads is called QueryService | Warning. Easy to confuse with QueryHandler |
| QueryHandler knows HTTP request/response or Controller-specific error conversion | REJECT |
| Adds a simple read wrapper with no additional decision | Consider removing. Controller may call QueryGateway directly |
| Prevent duplicate callbacks with Controller or application-process locks | REJECT. Does not work across instances |
| Determine processing state from Aggregate state | OK |
| Aggregate verifies callback attempt ID or generation | OK |
| Idempotently ignore old or duplicate callbacks by state transition | OK |
| Concurrency control is duplicated across Controller, UseCase, and Aggregate | REJECT |

## Eventual Consistency

| Criterion | Judgment |
|-----------|----------|
| No explicit contract to return the updated Read Model in the same response | Do not wait |
| The client or caller can keep the command input or generated ID | Do not wait |
| Infrastructure guarantees Projection update notification delivery to the waiting process | OK. Notification-driven waiting is acceptable |
| Existing infrastructure confirms update notifications reach subscribers | OK |
| Kafka or similar guarantees destination, redelivery, and missing-message handling operationally | OK |
| Subscription Query or event notification assumes single process/single instance, or guarantee is unknown | REJECT. Use the existing tracker / Read Model polling |
| `Thread.sleep` or equivalent blocks request threads while waiting for Projection updates | REJECT. Causes thread starvation under high concurrency |
| `delayedExecutor` / `CompletableFuture` is used to implement custom Projection-wait retry | REJECT. Use a reactive HTTP stack or the existing tracker |
| processStore / ProcessStore / materialStore / completeStep manages Projection update progress | REJECT. Projections should update idempotently from events |
| Updated state must be returned in the same HTTP response | Wait non-blockingly on a reactive HTTP stack |
| Same response does not need to wait | `202 Accepted` plus frontend long polling, normal polling, SSE, or WebSocket |
| UI expects immediate update | Frontend polling, SSE, or WebSocket. Server-side waiting only for a synchronous API contract |
| Consistency delay exceeds acceptable range | Reconsider architecture |
| Compensation transaction is undefined | Require failure-scenario review |

## Antipatterns, Tests, and Value Objects

| Criterion | Judgment |
|-----------|----------|
| CRUD façade that only imitates CQRS shape | REJECT |
| Anemic Domain Model where an Aggregate is only a data structure | REJECT |
| Event Soup with meaningless events emitted repeatedly | REJECT |
| Temporal Coupling with implicit event-order dependencies | REJECT |
| Missing Events for important domain facts | REJECT |
| God Aggregate containing all responsibilities | REJECT |
| Aggregate tests verify events rather than only state | Required |
| Query-side tests do not create data through commands | Recommended |
| Integration tests account for Axon asynchronous processing | Required |
| IDs are reused as raw String values | Consider value objects |
| The same field combination, such as from/to, appears in multiple places | Extract a value object |
| A value object contains business logic such as state transitions | REJECT. Aggregate responsibility |
| No `init` block guarantees invariants | REJECT |
