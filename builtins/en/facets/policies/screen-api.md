# Screen API Policy

Review the API contract for the fields and operations a screen needs, the amount of data it returns, server-side constraints, and consistency of update results.

## Response fields

| Condition | Decision |
|------|------|
| The response includes the identifiers, states, and related fields needed for display and operations | OK |
| A required field is missing, so another field with a different meaning is displayed in its place | REJECT |
| The list and detail view need different fields, counts, or authorization scopes, so their response contracts differ | OK |
| The client fetches every list item for a detail view and fills missing fields on the client | REJECT |
| Many related records are fetched with individual requests, increasing request count until the screen misses its response-time requirement | REJECT |

Choose separate APIs or one response from the required fields, counts, authorization, update frequency, and actual data size. Do not decide whether an API is specialized from its name alone.

## Data size and paging

A fixed small collection can be returned in one response. A result that may grow needs a server-validated limit and a response that identifies its order and continuation.

| Condition | Decision |
|------|------|
| A small collection has a limit that is explained by the specification and actual data, and all items are returned | OK |
| The client specifies page size, sort, or filter, and the server validates type, authorization, and limits | OK |
| The server accepts the client value without a bound on result size or response time | REJECT |
| A list that may grow is returned in full with no limit | REJECT |
| A cursor lacks a sort, filter, tenant, snapshot, or other condition that determines the result, so pages duplicate or omit items | REJECT |

For a page size received from the client, the server checks that it is an integer, positive, and within the subject's authorization scope, then caps it at the server's maximum. Treat an omitted value and the maximum as part of the server contract that protects fetch volume and response time, rather than deciding them only from the client's needs.

Judge client-controlled page size from the actual maximum size, permission scope, response time, and cursor stability, rather than from whether the client can specify a count.

## Aggregation and business decisions

Distinguish display sorting or totals calculated from a finite set already received from values confirmed by the server. The server returns aggregates or decisions involving large data, freshness, authorization, or business state together with their result scope.

| Condition | Decision |
|------|------|
| A bounded small list is totaled for display from the received items | OK |
| The client fetches an entire large or unbounded result to calculate a count, total, or decision | REJECT |
| The client alone confirms inventory, permission, whether something can be created, or another business state | REJECT |
| The server calculates an aggregate or decision and returns it with its scope and point in time | OK |
| The aggregate and detail data have different scopes or update times, so it is unclear which result is displayed | REJECT |

## Authorization and updates

The server checks the authenticated subject, target resource, tenant, current state, and operation permission before updating. It does not accept the client's display or permission decision as the final decision.

| Condition | Decision |
|------|------|
| The server reloads the subject and target and checks current authorization and state before updating | OK |
| Tenant, owner, and target ID conditions apply to both the search and the update | OK |
| Insufficient permission, missing target, state conflict, and invalid input produce the same success response | REJECT |
| The response does not distinguish failures that require different screen actions, such as correcting input, signing in again, resolving a conflict, or retrying | REJECT |
| The update is atomic when the version or ETag matches, and a conflict is not reported as success | OK |
| Retrying the same operation can create duplicates without idempotency or duplicate detection | REJECT |

When fetching and updating can happen concurrently, the API should make the result's point in time, rejection of stale writes, order for joining pages, and retry conditions readable. Use ETags, versions, idempotency keys, or snapshot cursors when they correspond to the actual conflict condition.
