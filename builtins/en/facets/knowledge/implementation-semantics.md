# Implementation Semantics

Knowledge for judging the micro-level design flaws that remain even when every test passes. The targets are data structure choice, state normalization, naming-meaning alignment, and fail-fast at boundaries. Each is a question of whether the meaning is correct, not whether the code runs, which is why tests are structurally bad at catching them.

## Meaning-Driven Data Structure Choice

Choose collection and dictionary types that match the meaning of the data. In particular, implementing a dictionary keyed by externally supplied strings as a plain object lets inherited prototype properties leak in.

| Criterion | Verdict |
|-----------|---------|
| A dictionary keyed by external input (IDs, user input) is implemented as `Record` / plain object and membership is checked with `in` or `obj[key]` | REJECT |
| Behavior can change for keys like `__proto__`, `constructor`, or `toString` | REJECT |
| Dynamic-key dictionaries use `Map`, or block the inheritance chain via `Object.create(null)` / `Object.hasOwn` | OK |
| A plain object is used for a fixed, finite key set (e.g. a config object) | OK |

```typescript
// REJECT - passing the ID "toString" reports it as present despite never being registered
const reservations: Record<string, Reservation> = {};
if (reservationId in reservations) { /* also matches inherited properties */ }

// OK - Map has no inherited-property leakage
const reservations = new Map<string, Reservation>();
if (reservations.has(reservationId)) { /* matches registered keys only */ }
```

## Single Source of Truth for Derived Values

Do not maintain a value in parallel when it can be computed from another. The moment it is duplicated, the two can drift, and the question of which one is authoritative is born with it.

| Criterion | Verdict |
|-----------|---------|
| A derivable value (total, count, version) is also incremented/decremented as a separate variable | REJECT |
| Detail records and an aggregate are updated in parallel and can diverge on invalid input | REJECT |
| Derived values are computed where used, or only the source is updated and the aggregate is obtained via a function | OK |
| When cached for performance, updates flow through a single path and divergence is detectable | OK |

```typescript
// REJECT - version is derivable from history length but tracked separately; drift corrupts stock math
class EventStore {
  private version = 0;
  append(e: Event) { this.events.push(e); this.version++; }
}

// OK - hold only the source and derive the version
class EventStore {
  get version() { return this.events.length; }
  append(e: Event) { this.events.push(e); }
}
```

## Naming-Meaning Alignment

A name states the meaning of the value it actually holds. A variable whose name and content diverge plants a false assumption in the reader and breeds the next bug.

| Criterion | Verdict |
|-----------|---------|
| The meaning implied by a variable/parameter name differs from the value actually stored (e.g. an ID stored in something named `qty`) | REJECT |
| Types match but the unit, coordinate system, or normalization state is unreadable from the name and gets mixed up | REJECT |
| The meaning, unit, and state of the content are unambiguously readable from the name | OK |

```typescript
// REJECT - named qtyShip, but the value is actually a reservation ID
function applyShipped(qtyShip: string) { delete this.reservations[qtyShip]; }

// OK - the name matches the meaning of the content
function applyShipped(reservationId: string) { delete this.reservations[reservationId]; }
```

## Fail-Fast at Boundaries

Fail immediately at the boundary on impossible states and contract-violating input instead of silently ignoring them. Swallowing them lets the inconsistency propagate downstream before it surfaces, making the cause hard to trace.

| Criterion | Verdict |
|-----------|---------|
| Input with broken preconditions (an event for a nonexistent target, ordering violations) is skipped without a word | REJECT |
| Exceptions are swallowed and a normal value is returned, so callers cannot detect the failure | REJECT |
| Contract violations surface immediately as explicit errors, exceptions, or Result types | OK |
| When ignoring is the spec, that decision is documented in a comment or the spec | OK |

```typescript
// REJECT - silently ignores events for products created later; corrupted event logs go undetected
apply(event: StockEvent) {
  const product = this.products[event.productId];
  if (!product) return;
}

// OK - fail immediately on impossible states to detect corruption early
apply(event: StockEvent) {
  const product = this.products.get(event.productId);
  if (!product) throw new Error(`event for unknown product: ${event.productId}`);
}
```

## Internal State Reference Leaks

When a store or read model returns references to its internal state as-is, caller-side mutations propagate into the persisted data. Return defensive copies or immutable views.

| Criterion | Verdict |
|-----------|---------|
| The collection is copied but the stored objects themselves are shared (shallow copy only) | REJECT |
| Mutating an obtained reference rewrites the persisted state | REJECT |
| Internal state is protected via defensive copies, freezing, or read-only views | OK |
