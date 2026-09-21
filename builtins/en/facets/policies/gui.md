# GUI Policy

Judge GUI hierarchy, state ownership, intent paths, and display/behavior responsibilities using observable harm.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Hierarchical containment | UI is reachable from Root, and an independent widget has an owner for its subtree |
| State ownership | Shared state and external side effects belong to an owner that can arbitrate consistency |
| Intent path | A child reports intent through an upper-level operation entry and the path to the owner is traceable |
| Display and behavior | Separate display rendering from state and side-effect arbitration where the boundary requires it |
| Evidence of harm | Reject ownerless state, broken boundaries, or duplicate operations when the effect is observable |
| Respect framework idioms | Do not reject hooks, Context, dispatch, queries, forms, or binding by name |
| Minimal change | Do not require classes, libraries, transition tables, or externalizing all state without a requirement |

## Hierarchy and State Ownership

| Criterion | Judgment |
|-----------|----------|
| UI is outside a hierarchy reachable from Root and no state owner can be traced | REJECT |
| A child writes parent state, a shared store, or canonical state in another subtree without using the owner's public update contract | REJECT |
| A small screen concentrates the state it needs in Root or its screen owner with clear consistency | OK |
| Hover, focus, in-progress input, or open/close state confined to a subtree lives in local state | OK |
| Context, a store, a query, or a form shares state with a clear owner and update path | OK |
| Root does not own every descendant state | Not a reason to reject |
| State is externalized or kept at Root as a formality | Not evidence by itself |

When multiple owners keep separate canonical copies and synchronization causes different display or operation results depending on update order, report the actual inconsistency. State placement follows subtree consistency and change paths.

## Display and Behavior

| Criterion | Judgment |
|-----------|----------|
| A display component arbitrates communication, shared-state mutation, or an external side effect without using its responsible owner's public operation entry | REJECT |
| A View receives display values and reports intent through a public callback or standard API | OK |
| A small component combines View and state arbitration while its owner and boundaries remain traceable | OK |
| A hook, reducer, Context Provider, store, query, or form implements the Mediator role | OK |
| The names Passive View, Mediator, or state machine, or a dedicated class, are absent | Not a reason to reject |
| A large migration or new abstraction layer is added only to separate these names | Check the requirement and impact |

## Intent and Events

| Criterion | Judgment |
|-----------|----------|
| A child bypasses the owner's public operation entry and directly changes another owner | REJECT |
| An intermediate component delegates a callback or dispatch without changing its meaning | OK |
| The responsible owner accepts or rejects intent from state and does not let an ancestor execute the same intent again | OK |
| An unhandled intermediate intent is delegated upward | OK |
| Native event propagation is distinguished from application-level intent notification | OK |
| Event-path stopping is required only as a formal pattern | Not a reason to reject |
| The same operation intent executes twice through multiple paths | REJECT |
| An ancestor repeats the same intent after the responsible owner handled it | REJECT |

Do not reject callback prop passing because it is deep. Inspect the actual path for re-owned state or changed operation meaning.

## Frameworks and Composition

| Criterion | Judgment |
|-----------|----------|
| Standard hooks, Context, dispatch, query, form, or binding are used with a clear owner and operation path | OK |
| A child calls an operation callback exposed by its parent and the responsible owner updates state | OK |
| A Mediator class, a particular library, or a fixed directory layout is absent | Not a reason to reject |
| All state is moved to an external store and local state is prohibited | Not a GUI requirement |
| Changing the mechanism does not fix ownerless state or duplicate processing | REJECT. Fix the actual harm |
