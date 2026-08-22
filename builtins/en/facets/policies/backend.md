# Backend Policy

Provide one source of truth for independent judgments about backend.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## Backend Criteria

### Hexagonal Architecture (Ports and Adapters)

| Criteria | Judgment |
|----------|----------|
| Framework dependencies in domain layer (@Entity, @Component, etc.) | REJECT |
| Controller directly referencing Repository | REJECT. Must go through UseCase layer |
| Outward dependencies from domain layer (DB, HTTP, etc.) | REJECT |
| Direct dependencies between adapters (inbound → outbound) | REJECT |
| Types or identifiers in the application/domain layer carry protocol-specific meaning such as HTTP request/response, endpoint, or status code | REJECT. Translate them into use-case concepts at the boundary. A domain term that happens to contain words such as Request is not itself a violation |

### Request/Response DTO Design

| Criteria | Judgment |
|----------|----------|
| Returning domain model directly as response | REJECT |
| Business logic in Request DTO | REJECT. Only validation is allowed |
| Domain logic (calculations, etc.) in Response DTO | REJECT |
| Same type for Request and Response | REJECT |

### RESTful Action Design

| Criteria | Judgment |
|----------|----------|
| PUT/PATCH for domain operations (approve, cancel, etc.) | REJECT. Use POST + verb sub-resource |
| Single endpoint branching into multiple operations | REJECT. Separate endpoints per operation |
| DELETE for soft deletion | REJECT. Use POST + explicit operation like cancel |

### Validation Strategy

| Criteria | Judgment |
|----------|----------|
| Domain state transition rules in API layer | REJECT |
| Business rule verification in Controller | REJECT. Belongs in UseCase layer |
| Structural validation (@NotBlank, etc.) in domain | REJECT. Belongs in API layer |
| UseCase-level validation inside Aggregate | REJECT. Read Model queries belong in UseCase layer |

### Entry Validation Ownership

| Criteria | Judgment |
|----------|----------|
| Same entry and same condition implemented in multiple validation mechanisms | REJECT. Make a single mechanism the effective owner and delete the unreachable side |
| Status and response shape on a validation violation do not match the explicit API contract (including implicit reliance on the default translation with no contract defined) | REJECT. Make the contract explicit and wire the translation |
| No test pinning the status and response shape on validation violation | REJECT. Verify the actual exception type with an integration test |
| Validation policy is inconsistent across entrypoints sharing the same trust boundary and input contract | REJECT. State the reason for the difference or unify the policy |
| External error contract depends on messages from the runtime's default locale | REJECT. Use stable error codes or explicit messages as the contract |
| Constraint values (max length, etc.) share a single constant across validation and API spec | OK |

### Read and Write Entrypoints

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

### Exception Hierarchy Design

| Criteria | Judgment |
|----------|----------|
| HTTP status codes in domain exceptions | REJECT. Domain must not know about HTTP |
| Throwing generic Exception or RuntimeException | REJECT. Use specific exception types |
| Empty try-catch blocks | REJECT |
| Controller swallowing exceptions and returning 200 | REJECT |
| Expressing an actually reachable call pattern (e.g., a caller with a different role) as a 500 | REJECT. Make it an explicit 4xx; guarantee "unreachable" assumptions with authorization |

### Exception Translation Scope

| Criteria | Judgment |
|----------|----------|
| Each endpoint maps exceptions to HTTP representation through the same try-catch or wrapper | REJECT. Move it to an exception translation layer at the HTTP adapter boundary |
| API-specific exception mapping is added to a global handler | Scope is too broad. Keep it inside the target API boundary |
| Authentication failures, input validation, and common error shapes shared by all APIs | OK. Handle at a global boundary |
| HTTP representation mapping lives in the application or domain layer | REJECT. Keep it at the HTTP adapter boundary |
| Multiple translation layers handle the same exception type without a contract for scope and precedence | REJECT. Consolidate under a single owner or make the non-overlapping applicability explicit |

### Immutable + require

| Criteria | Judgment |
|----------|----------|
| `var` fields in domain model | REJECT. Use `copy()` for immutable updates |
| Factory without validation | REJECT. Enforce invariants with `require` |
| Domain model calling external services | REJECT. Pure functions only |
| Direct field mutation via setters | REJECT |

### Value Objects

| Criteria | Judgment |
|----------|----------|
| Same-typed IDs that can be mixed up (orderId and customerId both String) | Consider wrapping in value objects |
| Same field combinations (from/to, etc.) appearing in multiple places | Extract to value object |
| Value object without init block | REJECT. Enforce invariants |

### Read Model Entity (JPA Entity)

| Criteria | Judgment |
|----------|----------|
| Domain model doubling as JPA Entity | REJECT. Separate them |
| Business logic in Entity | REJECT. Entity is data structure only |
| Repository implementation in domain layer | REJECT. Belongs in adapter/outbound |

### Persistence Boundary for Structured Attributes

| Criteria | Judgment |
|----------|----------|
| Bounded structure read and written as a whole, with no need for search, joins, referential integrity, or partial updates | Consider a structured column (JSON, etc.) |
| Referential integrity, an independent lifecycle, or joins with other tables matter | Normalize into its own table |
| The DB's structured-column features (jsonb, etc.) can guarantee the needed search, indexing, and partial updates, and integrity requirements are met | A structured column is also a valid choice |
| Domain type is converted directly by a generic serializer, implicitly using its field names as the DB schema | REJECT. Insert a persistence-specific representation or an explicit mapping |

### Authentication & Authorization Placement

| Criteria | Judgment |
|----------|----------|
| Authorization logic in UseCase or domain layer | REJECT. Belongs in Controller layer |
| Data access control in Controller | REJECT. Belongs in UseCase layer |
| Authentication processing inside Controller | REJECT. Belongs in Filter/Interceptor |
| Application-layer service reads the security context directly (e.g., resolving the current user) | REJECT. Resolve at the boundary and pass as an argument |
| The same authorization check is duplicated in the Controller and a lower layer | REJECT. Consolidate the responsibility in one place |

### Distinguishing the Caller from the Domain Actor

| Criteria | Judgment |
|----------|----------|
| Unconditionally recording the caller as the business actor | Warning. Verify it does not break on ingestion, delegated, or administrative paths |
| Reusing the creation-time caller, via state, as the actor of later operations | REJECT. Pass the performer as an argument per operation |
| Requiring an actor field before the business actor is actually determined | Warning. Check whether it can be recorded at the operation that determines it (approval, confirmation, etc.) |
| Resolving denormalized display names (etc.) at the boundary of the operation that establishes the fact | OK |
| Placing resolution logic that assumes the caller is a member of the resource on a path also used by non-members | REJECT |

### UseCase Testing

| Criteria | Judgment |
|----------|----------|
| Using mocks for domain model tests | REJECT. Test domain purely |
| UseCase tests connecting to real DB | REJECT. Use mocks |
| Tests requiring framework startup | REJECT for unit tests |
| Missing error case tests for state transitions | REJECT |

## Anti-Pattern Detection

| Pattern | Decision |
|---------|----------|
| Smart Controller | REJECT: business logic is concentrated in the Controller |
| Anemic Domain Model | REJECT: the domain model is only a setter/getter data structure |
| God Service | REJECT: one Service class owns every operation |
| Direct Repository Access | REJECT: a Controller reaches directly into a Repository |
| Domain Leakage | REJECT: domain logic leaks into an adapter layer |
| Entity Reuse | REJECT: a JPA Entity is reused as the domain model |
| Swallowed Exceptions | REJECT: an empty catch block hides failure |
| Magic Strings | REJECT: status strings or similar meanings are hardcoded |
