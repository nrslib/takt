# React Policy

Judge React state, props, Context, reducers, Effects, and Hooks from rerenders, state lifetime, Mediator operation decisions, and synchronization with external systems.

## State, props, and derived values

| Criterion | Decision |
|------|------|
| Sibling components keep shared state in separate `useState` calls, so their displays or operations diverge | REJECT |
| A component needs to respond to prop changes but copies the initial value into state and keeps displaying the old value | REJECT |
| A list, count, all-selected result, or label calculable from state is synchronized as separate state through an Effect | REJECT |
| A common parent owns one state value and passes props and operation callbacks to children | OK |
| Controlled input, an editing draft, or recreation with `key` is chosen to match the required state lifetime | OK |
| Memoization hides dependencies and update paths without addressing an actual computation or reference problem | REJECT |

## Context, reducers, and operations

| Criterion | Decision |
|------|------|
| A Provider or component creates values with `useState`, `useReducer`, a query, or similar, and Context distributes the values and operations | OK |
| A reducer performs communication, timers, notifications, or other side effects | REJECT |
| A reducer returns the next state from state and an event; a handler communicates and dispatch reflects the result | OK |
| Form, button, keyboard, or other entries reach the same handler, which accepts or rejects them using current state | OK |
| Multiple entries such as click and submit call the same communication directly and send it twice | REJECT |

## Effects and dependencies

| Criterion | Decision |
|------|------|
| An Effect reads a reactive value without including it in the dependencies and synchronizes with an old value | REJECT |
| Dependencies do not match the conditions that should cause reconnection or refetching | REJECT |
| A callback or Context value reference changes and actually causes repeated refetching or reconnection that is unnecessary for the behavior | REJECT |
| One Effect combines separate synchronizations, so an unrelated value reruns both | REJECT |
| A connection, subscription, timer, or fetch has no cleanup before rerun or on unmount, leaving old resources or results | REJECT |
| The synchronization target and rerun conditions are defined, dependencies are explicit, and cleanup is returned | OK |

Do not change a dependency array just to silence a lint warning. First organize what is synchronized by moving values outside the Effect, moving one-off work to an operation handler, or splitting synchronizations.

## React execution rules

| Criterion | Decision |
|------|------|
| A Hook is called outside the top level of a component or custom Hook, so its call order changes between renders | REJECT |
| Rendering performs communication, notifications, DOM operations, or changes to external variables | REJECT |
| Props, state, or values inside them are mutated directly | REJECT |
| A reorderable list uses an index as `key`, so input or selection state moves to another item after reordering | REJECT |
| A stable item identifier is used as `key`, and component position and state lifetime match the intended behavior | OK |

## Custom Hooks

| Criterion | Decision |
|------|------|
| A Hook groups state, Effects, Context, queries, forms, and event conversion as one screen behavior | OK |
| A Hook wraps only a pure calculation | Consider using a regular function instead |
| A Hook, component, and screen have circular dependencies that hide the path for changing display or communication | REJECT |
| The path from state, events, and derived values returned by a Hook to rendering inputs is clear | OK |

`useState` inside a Hook creates separate state for each call to that Hook. A Hook that reads Context, a query, or an external store can return a value shared by its source, so judge what it actually reads and writes.
