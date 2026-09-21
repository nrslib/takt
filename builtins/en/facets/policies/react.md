# React Policy

Judge React-specific re-execution, state retention, Context, hooks, and queries from actual responsibilities, dependencies, and consistency contracts.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply these criteria only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Code and dependencies | Match reactive values read by an Effect with its re-execution conditions |
| Cleanup | Release external connections, subscriptions, and timers on every exit path |
| State ownership | Inspect the owner and operation path rather than the names of hooks, reducers, Context, stores, queries, or forms |
| Query consistency | Check query keys, invalidation, refetching, and page continuity against the data contract |
| Observable harm | Judge loops, leaks, gaps, duplicates, or stale displays that can be observed |
| Keep scope bounded | Judge only the scope causally related to the request |
| Use consistent grounds | Do not add a judgment criterion from an example that cannot be derived from the original requirement, changed contract, or real impact paths |

## Effects and Dependencies

| Criteria | Judgment |
|----------|----------|
| An Effect reads a reactive value but omits it from dependencies and uses a stale value | REJECT |
| An unstable function or Context value reference alone repeats initial loading or a subscription | REJECT |
| A mount-only initial load reruns when recreated function references change | REJECT |
| A Context or Provider function reference alone repeats an out-of-contract initial load or subscription | REJECT |
| A mount-only list load is retriggered by loading-state updates | REJECT |
| A mount-only list load is retriggered by message display or dialog toggles | REJECT |
| A dependency is added only to satisfy lint and causes an unintended refetch or reconnection | REJECT |
| One Effect combines independent synchronization processes so unrelated changes rerun both | REJECT |
| An external connection, subscription, or timer has no cleanup and survives rerender or unmount | REJECT |
| An empty dependency list is used when the Effect reads no reactive values and its mount synchronization and cleanup match the contract | OK |
| A mount-only Effect reads no reactive values and its synchronization and cleanup match the contract | OK |
| A lint suppression hides a reactive-value mismatch and leaves stale data or misses a rerun | REJECT |
| An Effect that should rerun is incorrectly frozen with an empty dependency list | REJECT |

## Handling exhaustive-deps

When dependencies change, inspect the synchronized system, work that belongs in an event handler, and independent processes that should be split. Do not decide from the presence of a suppression comment alone.

## State, Context, and Hooks

| Criteria | Judgment |
|----------|----------|
| Local useState stays within its subtree owner and does not perform opaque changes in another subtree | OK |
| A reducer, Context Provider, dispatch, or store centralizes state and operation entries | OK |
| A query hook, form hook, or binding owns state and operations with a traceable path from display | OK |
| The same stateful hook is called in multiple places under the assumption that its state is shared, creating separate canonical states | REJECT |
| Context, hook, or reducer names are used without checking ownership or operation paths | REJECT |
| Standard hooks, Context, local state, and parent callbacks are prohibited because of their API form | REJECT |

## Custom Hook Responsibility

| Criteria | Judgment |
|----------|----------|
| A `use*` function composes React hooks, Context, query, form, or event translation with a traceable responsibility | OK |
| A `use*` function only wraps a pure calculation and uses no React hook or state/operation contract | Consider simplification |
| Stateful UI control lives in a custom hook while pure calculations live in ordinary functions | OK |
| A hook returns JSX while its ownership and operation path are clear | Not a reason to reject by return shape alone |
| A hook hides an operation owner or causes an opaque or duplicate side effect, including through returned JSX | REJECT |

## Props Type Placement and Hook Boundaries

| Criteria | Judgment |
|----------|----------|
| A single component's private Props type is moved to a `types` file without a clear reason | Warning |
| Props are moved to a separate file only so a hook can import a component's Props type | REJECT |
| Shared Props or data contracts used by multiple components or public APIs live in a separate file | OK |
| A hook returns state, events, and derived values while a container maps them to component props | OK |
| Even when a hook returns a props-like object, the hook does not depend on the component's Props type | OK |

## Queries, Cache, and Pagination

| Criteria | Judgment |
|----------|----------|
| A query key omits the resource, URL, filters, user, or another identity condition and shares different data | REJECT |
| No invalidation, refetch, or contract-compliant cache update after an update leaves stale data as canonical display | REJECT |
| Cursor or offset refetching has no contract for page continuity, duplicates, or gaps | REJECT |
| Pages are fetched and refetched according to the query or infinite-query API and server contract | OK |
| A query cache is prohibited solely because the data uses cursor or offset pagination | Not a reason to reject |
| A query hook hides fetch conditions, errors, and post-update consistency from every traceable owner and produces different data or an incorrect display | REJECT |
| A stable detail resource or stable list uses a query cache with a matching identity and update contract | OK |

## Forms and Standard APIs

| Criteria | Judgment |
|----------|----------|
| A controlled or uncontrolled input, form library, or binding has a clear state owner | OK |
| Context dispatch or a parent-provided callback reports operation intent | OK |
| A change only converts standard hooks, Context, queries, or forms into a particular MVP shape | Not a reason to reject |
