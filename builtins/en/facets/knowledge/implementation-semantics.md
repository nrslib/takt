# Implementation Semantics

Knowledge for judging the micro-level design flaws that remain even when every test passes. The targets are data structure choice, state normalization, naming-meaning alignment, and fail-fast at boundaries. Each is a question of whether the meaning is correct, not whether the code runs, which is why tests are structurally bad at catching them.

## Test Expectations Follow the Original Requirement

Expected behavior comes from the original requirement and specification, not from whatever the current implementation happens to do. Tests that merely reproduce current behavior can preserve a defect.


## Meaning-Driven Data Structure Choice

Choose collection and dictionary types that match the meaning of the data. In particular, implementing a dictionary keyed by externally supplied strings as a plain object lets inherited prototype properties leak in.


Never flag a guarded `Record` as "should be a `Map`". Blocking the inheritance chain via `Object.hasOwn` / `Object.create(null)` is a complete mitigation, and continuing to use `Record` on top of it is not a design flaw. In particular, when a published contract (a frozen type definition) mandates `Record`, guarding is everything the implementation can do. The only reportable finding is a remaining unguarded access, and it must be cited with its location.

```typescript
// Avoid: passing the ID "toString" reports it as present despite never being registered
const reservations: Record<string, Reservation> = {};
if (reservationId in reservations) { /* also matches inherited properties */ }

// Example: Map has no inherited-property leakage
const reservations = new Map<string, Reservation>();
if (reservations.has(reservationId)) { /* matches registered keys only */ }
```

## Single Source of Truth for Derived Values

Do not maintain a value in parallel when it can be computed from another. The moment it is duplicated, the two can drift, and the question of which one is authoritative is born with it.


```typescript
// Avoid: version is derivable from history length but tracked separately; drift corrupts stock math
class EventStore {
  private version = 0;
  append(e: Event) { this.events.push(e); this.version++; }
}

// Example: hold only the source and derive the version
class EventStore {
  get version() { return this.events.length; }
  append(e: Event) { this.events.push(e); }
}
```

## Naming-Meaning Alignment

A name states the meaning of the value it actually holds. A variable whose name and content diverge plants a false assumption in the reader and breeds the next bug.


```typescript
// Avoid: named qtyShip, but the value is actually a reservation ID
function applyShipped(qtyShip: string) { delete this.reservations[qtyShip]; }

// Example: the name matches the meaning of the content
function applyShipped(reservationId: string) { delete this.reservations[reservationId]; }
```

## Fail-Fast at Boundaries

Fail immediately at the boundary on impossible states and contract-violating input instead of silently ignoring them. Swallowing them lets the inconsistency propagate downstream before it surfaces, making the cause hard to trace.


```typescript
// Avoid: silently ignores events for products created later; corrupted event logs go undetected
apply(event: StockEvent) {
  const product = this.products[event.productId];
  if (!product) return;
}

// Example: fail immediately on impossible states to detect corruption early
apply(event: StockEvent) {
  const product = this.products.get(event.productId);
  if (!product) throw new Error(`event for unknown product: ${event.productId}`);
}
```

## Internal State Reference Leaks

When a store or read model returns references to its internal state as-is, caller-side mutations propagate into the persisted data. Return defensive copies or immutable views.


## Identifier Namespace Collisions

Generated IDs, tokens, and keys must not collide with either existing input namespaces or downstream syntax. Having a unique source of sequence numbers is different from having a collision-free identifier.
