# React Policy

Judge React state, props, Context, reducers, Effects, and hooks from re-execution, state lifetime, operation paths, and synchronization with external systems.

## Principles

| Principle | Criterion |
|-----------|-----------|
| State ownership | One owner keeps each fact, with traceable display and operation paths |
| Props | Parent inputs and component-local editing state have distinct lifetimes |
| Context | Deep components receive values and operation entries through an explicit value owner |
| Reducer | Current state and intent produce the next state without side effects |
| Effect | Rendering synchronizes with external systems through dependencies and cleanup that match the target |
| Hook | Stateful responsibility and its direction from screen behavior to display remain traceable |
| React runtime rules | Hook, render, props, and key rules support the state lifetime and re-execution reasoning |
| Evidence | Judge actual reruns, omissions, duplicates, stale displays, and mixed responsibilities rather than API form |

## State, props, and derived values

| Criterion | Judgment |
|-----------|----------|
| Sibling components keep shared state in separate `useState` calls and their display or operation results diverge | REJECT |
| A component needs to respond to prop changes but keeps showing a copied initial value | REJECT |
| A list, count, all-selected flag, or label computable from state is synchronized as another state through an Effect | REJECT |
| State lives in the smallest common component and flows through props and operation entries to display | OK |
| Controlled input, local editing draft, or component identity change matches the required state lifetime | OK |
| Memoization hides dependencies and does not address a measured computation or reference-stability problem | REJECT |

Choose state placement from sharing scope, lifetime, update operations, and display reflection.

## Context, reducer, and operation entries

| Criterion | Judgment |
|-----------|----------|
| A Provider or component calls `useState` or `useReducer` and the Context operation path is traceable | OK |
| Context contains screen-specific communication and several canonical states whose update operations cannot be traced | REJECT |
| A reducer performs communication, timers, or notifications so side effects cannot be distinguished from state changes | REJECT |
| A reducer returns the next state purely from current state and event while a handler or Effect owns side effects | OK |
| Buttons, forms, and keyboard operations enter one command and current state accepts or rejects them | OK |
| Click and submit paths call the same communication directly and cause duplicate submission | REJECT |

Context distributes values. Review the Provider or component that calls `useState` or `useReducer`, as well as query and form owners, to identify the state and operation owner for each subtree.

## Effects and dependencies

| Criterion | Judgment |
|-----------|----------|
| An Effect omits a reactive value it reads and synchronizes with a stale value | REJECT |
| Effect dependencies do not match the conditions that should reconnect or refetch | REJECT |
| A callback or Context value reference alone causes functionally unnecessary refetches or reconnections that occur in practice | REJECT |
| Independent synchronization processes share one Effect and unrelated changes rerun both | REJECT |
| A connection, subscription, timer, or request has no cleanup on rerun or unmount | REJECT |
| The synchronization target and read values are explicit, dependencies match, and cleanup is returned | OK |
| A mount-only synchronization reads no reactive value and its start/stop contract is explicit | OK |

Choose the synchronization target before changing dependencies. Move a value outside the reactive scope, move one-time interaction work to a handler, or split independent synchronization when that makes the contract clear. A required rerun stays represented in dependencies.

## React runtime rules

| Criterion | Judgment |
|-----------|----------|
| A Hook is called outside the top level of a component or custom hook, changing call order across renders | REJECT |
| Rendering performs communication, notifications, DOM operations, or mutation of an external variable | REJECT |
| Props, state, or nested values owned by them are mutated directly | REJECT |
| An index key causes input or selection state to move to another item after a reorderable list changes order | REJECT |
| Stable item identifiers are used as keys and component identity matches the intended state lifetime | OK |

## Custom hooks and component boundaries

| Criterion | Judgment |
|-----------|----------|
| A hook composes React state, Effects, Context, queries, forms, or event translation as one traceable responsibility | OK |
| A hook only wraps a pure calculation without a stateful contract | Consider an ordinary function |
| Hook, component, and screen dependencies form a cycle that hides how changes reach display or communication | REJECT |
| Hook state, events, and derived values are mapped to component render parameters through a readable path | OK |

Treat a React component with local state or event handlers separately from strict Passive View. Where screen or region arbitration is required, keep communication and transition decisions out of the display portion while using idiomatic hooks, reducers, and handlers.
