# Implementation Semantics Policy

Provide one source of truth for independent judgments about implementation semantics.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## Implementation Semantics Criteria

### Test Expectations Follow the Original Requirement

| Criterion | Verdict |
|-----------|---------|
| A test expectation is derived only from the current implementation | REJECT |
| A passing test encodes behavior that conflicts with the original requirement or specification | REJECT |
| Expected behavior is traced to the original requirement or specification, including failure behavior | OK |

### Meaning-Driven Data Structure Choice

| Criterion | Verdict |
|-----------|---------|
| A dictionary keyed by external input (IDs, user input) is implemented as `Record` / plain object and membership is checked with `in` or `obj[key]` | REJECT |
| Behavior can change for keys like `__proto__`, `constructor`, or `toString` | REJECT |
| Dynamic-key dictionaries use `Map`, or block the inheritance chain via `Object.create(null)` / `Object.hasOwn` | OK |
| A plain object is used for a fixed, finite key set (e.g. a config object) | OK |

### Single Source of Truth for Derived Values

| Criterion | Verdict |
|-----------|---------|
| A derivable value (total, count, version) is also incremented/decremented as a separate variable | REJECT |
| Detail records and an aggregate are updated in parallel and can diverge on invalid input | REJECT |
| Derived values are computed where used, or only the source is updated and the aggregate is obtained via a function | OK |
| When cached for performance, updates flow through a single path and divergence is detectable | OK |

### Naming-Meaning Alignment

| Criterion | Verdict |
|-----------|---------|
| The meaning implied by a variable/parameter name differs from the value actually stored (e.g. an ID stored in something named `qty`) | REJECT |
| Types match but the unit, coordinate system, or normalization state is unreadable from the name and gets mixed up | REJECT |
| The meaning, unit, and state of the content are unambiguously readable from the name | OK |

### Fail-Fast at Boundaries

| Criterion | Verdict |
|-----------|---------|
| Input with broken preconditions (an event for a nonexistent target, ordering violations) is skipped without a word | REJECT |
| Exceptions are swallowed and a normal value is returned, so callers cannot detect the failure | REJECT |
| Contract violations surface immediately as explicit errors, exceptions, or Result types | OK |
| When ignoring is the spec, that decision is documented in a comment or the spec | OK |

### Internal State Reference Leaks

| Criterion | Verdict |
|-----------|---------|
| The collection is copied but the stored objects themselves are shared (shallow copy only) | REJECT |
| Mutating an obtained reference rewrites the persisted state | REJECT |
| Internal state is protected via defensive copies, freezing, or read-only views | OK |

### Identifier Namespace Collisions

| Criterion | Verdict |
|-----------|---------|
| A generated value can collide with existing input, reserved words, delimiter syntax, or downstream persistence, display, or lookup interpretation | REJECT |
| The sequence source is unique but downstream code cannot distinguish the identifier from another value | REJECT |
| A namespace distinguishable from both existing input and downstream syntax is proven | OK |
