# Screen-Specific API Policy

Design and judge the data needed by a screen or region through API response fields, data volume, server-side constraints, and result consistency. This policy covers the server data contract; component structure and request timing belong to frontend guidance.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Response fields | Include identifiers, state, related data, and aggregates required by display and operations |
| Data volume | The server validates result size, limits, pagination, and cursor conditions against actual data |
| Server authority | The server decides authorization, business judgments, and persistence-dependent transitions from current data |
| Aggregation | Choose server aggregation or finite client-side derivation from volume and decision semantics |
| Result consistency | Define concurrent updates, page continuity, duplicates/gaps, and stale responses in the API contract |
| Error contract | Distinguish authentication/authorization, invalid input, conflict, missing resources, and server failures |

## Response fields and endpoints

Design response shapes around what the screen displays and operates on. A screen and endpoint do not need a one-to-one naming relationship; the contract must provide the actual required fields and operations.

| Criterion | Judgment |
|-----------|----------|
| Required identifiers, state, or related fields are missing and another field with a different meaning is used as a substitute | REJECT |
| A list response includes the identifiers, counts, related fields, and state required by its screen contract | OK |
| List and detail responses have separate contracts because fields, volume, or authorization scope differ | OK |
| A detail field is missing and the client fetches an unbounded list to fill it | REJECT. Design the field or retrieval boundary |
| Related data requires so many individual requests that actual volume or response time exceeds the allowed range | REJECT |
| A list response also serves detail when its fields, item count, and authorization satisfy the detail contract | OK |

```typescript
// Bad: use a list summary as a detail description
async function loadDetail(id: string) {
  const list = await fetchList({ date })
  const item = list.items.find(item => item.id === id)
  return item && { ...item, description: item.summary }
}

// Good: the detail contract returns the required fields and authorization scope
async function loadDetail(id: string) {
  return await fetchDetail(id)
}
```

Choose separate or shared list/detail responses from required fields, result count, authorization, update frequency, and actual data volume. Endpoint names alone are not evidence.

## Data volume and pagination

A fixed, explicitly small collection can be returned in one response. Results that can grow require server-validated limits, a pagination method, and an ordering contract. A client may provide page size, sort, or filter parameters when the server validates their types, allowed range, and maximum response contract.

| Criterion | Judgment |
|-----------|----------|
| A fixed small collection is returned in full and its upper bound is supported by the specification and actual data | OK |
| The client supplies `limit`, page size, sort, or filter and the server validates its type, authorization scope, and cap | OK |
| The server accepts client size parameters without a bound on result volume or response time | REJECT |
| A potentially large list is returned in full without a cap | REJECT |
| A cursor omits sort, filter, tenant, snapshot, or another result condition and pages duplicate or omit records | REJECT |
| The server has default and maximum values and clamps client input to that range | OK |

```typescript
// Good: the request accepts a size, and the server applies its maximum
const result = await fetchList({ date, limit: 20, nextId })

// Server-side example
const requestedSize = request.limit ?? DEFAULT_PAGE_SIZE
if (!Number.isInteger(requestedSize) || requestedSize < 1) {
  throw new RangeError('limit must be a positive integer')
}
const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE)
return listOrders({ date: request.date, nextId: request.nextId, pageSize })
```

Judge the actual maximum data volume, authorization scope, response time, and cursor stability. A `limit` or pagination parameter is not itself a defect.

## Aggregation and business decisions

Separate display aggregation of a finite response from a client-side final business decision. When volume is large, freshness matters, or authorization and business state are involved, design a server aggregation or decision response.

| Criterion | Judgment |
|-----------|----------|
| A bounded small list is totaled for display using only fields in the response | OK |
| An unbounded or unknown-size collection is fetched to compute a count, total, or business decision | REJECT |
| Inventory, permission, generation eligibility, or a business transition is finalized only by the client | REJECT |
| The server computes an aggregate or decision from current data and returns it with its state basis | OK |
| Aggregate and detail cover different scopes or update times, so the displayed result cannot be identified | REJECT |

## Server authorization and constraints

The server does not treat a client-rendered flag, count, price, inventory value, or permission as the final decision. It validates the authenticated actor, resource, tenant, current state, and operation permission, then returns a contracted rejection reason.

| Criterion | Judgment |
|-----------|----------|
| Persistence or permission change is allowed from a request's `canApprove` or other client-computed value alone | REJECT |
| The server reloads the resource for the actor and validates current authorization and state before operating | OK |
| Tenant, owner, and resource conditions apply to both server lookup and update | OK |
| Forbidden, missing, conflicting, and invalid requests return the same success response | REJECT |

## Result consistency

When reads and updates run concurrently, the API contract defines the result point, stale-write behavior, page ordering, and retry conditions. Choose ETag, version, idempotency key, or snapshot cursor when it addresses an actual conflict condition.

| Criterion | Judgment |
|-----------|----------|
| Version or ETag comparison and the update are atomic, and a conflicting update is not reported as successful | OK |
| A retried operation can create duplicates and has no idempotency or duplicate detection | REJECT |
| Cursor order, filter, and snapshot remain stable across pages | OK |
| The relationship between success and persistence, and retry conditions after failure, is traceable from the API | OK |

Frontend guidance covers display and request timing. This policy checks whether the API returns sufficient fields and volume and whether the server can guarantee authorization, business decisions, and result consistency.
