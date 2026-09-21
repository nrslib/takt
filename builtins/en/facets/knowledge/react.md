# React Knowledge

Understand standard React state, effects, Context, hooks, queries, and forms through GUI responsibilities and runtime contracts.

## State and Ownership

`useState` has an independent state instance for each component that calls the hook. When state must be shared, call the hook in the smallest common owner, place it in Context or a store, or centralize updates with a reducer and dispatch according to the required scope.

| State or contract | React realization |
|-------------------|-------------------|
| UI state confined to a subtree | `useState` or `useReducer` |
| State shared by several components | Context, Provider, or a store |
| State and operations arbitrated in one place | A reducer, dispatch, or custom hook |
| Server data | A query hook, cache, invalidation, and refetch |
| Form input and validation | Controlled or uncontrolled inputs, a form library, or binding |

Do not reject Context, reducers, Root-owned state that is actually needed, or concentrated state in a small screen by form alone. Trace who owns state, which operation updates it, and which display reflects it.

## Effects and Re-execution

`useEffect` synchronizes with a system outside React rendering. Use it for connections, subscriptions, timers, and other start/stop synchronization, rather than as a generic place to put initialization. Decide first whether a load is mount-only or should rerun on dependency changes. A side effect that belongs to one user interaction, such as submitting or showing a notification, belongs in the event handler or command that owns that operation.

Props, state, and values or functions created inside the component that an Effect reads determine its reactive conditions. The dependency list is determined by the Effect code and the intended synchronization, not selected merely to silence a linter. To remove an unnecessary dependency, change the code first: move a value outside the reactive scope, move interaction-specific work to an event handler, or split independent synchronization processes.

An Effect that creates an external connection or subscription releases it in cleanup. It must remain correct if setup and cleanup are run an extra time in development, without duplicate subscriptions or leaked connections. Use an empty dependency list only when the Effect reads no reactive values and its mount synchronization and cleanup match the actual contract.

```tsx
// Avoid: initial load can rerun because unstable function deps leak into the effect
const fetchList = useCallback(async () => {
  await loadItems()
}, [setIsLoading, errorPage])

useEffect(() => {
  fetchList()
}, [fetchList])

// Example: a mount-only load reads only a module-scope function and constant, then cleans up its synchronization
import { loadItemsOnMount } from './items-api'
const initialEndpoint = '/api/items'

useEffect(() => {
  const controller = new AbortController()
  void loadItemsOnMount(initialEndpoint, controller.signal)
  return () => controller.abort()
}, [])
```

## Context and Provider Values

`value={{ ... }}` in a Provider creates a new reference on each Provider render. When functions obtained from Context are placed in Effect dependencies, consumers can enter unintended refetch loops. Distinguish rerenders or Effect re-execution caused by a changing value reference from the refetch conditions the feature actually needs. Using a Context dispatch or operation from an event handler is a standard pattern and is not a reason to reject the design.

```tsx
// In this example the Provider recreates these Context functions, so an unrelated
// loading-state rerender repeats the initial load.
// Avoid: Context functions are used directly as initial-load Effect deps
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData(setIsLoading, errorPage)
}, [setIsLoading, errorPage])

// Example: report an operation through Context from an event handler,
// while initial loading remains an independent synchronization
import { loadInitialData } from './items-api'
const { dispatch } = useAppContext()
const initialEndpoint = '/api/items'

useEffect(() => {
  const controller = new AbortController()
  void loadInitialData(initialEndpoint, controller.signal)
  return () => controller.abort()
}, [])

function handleRetry() {
  dispatch({ type: 'retry' })
}
```

## Initial Page Load

Treat initial page load separately from reactive refetching. Keep the initial fetch mount-only when that is the contract; when filter, URL, pagination, explicit user action, or another declared condition requires refetching, reflect that value or operation in dependencies, query keys, or operation inputs. Loading, message, and dialog state are not refetch triggers by themselves.

| Condition | Behavior |
|-----------|----------|
| List is loaded once on page entry | mount-only Effect with a documented contract |
| Refetching follows filter, pagination, or URL changes | make those states explicit dependencies, query keys, or operation inputs |
| Loading, message, or dialog state changes | keep separate from initial-load triggers |

## Queries, Cache, and Pagination

Data-fetching library caching is selected from the data and consistency contract. A single resource detail or stable list can use a query cache. Cursor- or offset-paginated lists can also use a query cache or infinite query when query identity, invalidation, refetching, page continuity, duplicate/gap handling, and the visible snapshot are explicit.

Cursor or offset pagination is not by itself proof that a cache is unsuitable. Mid-stream additions, deletions, reordering, stale cursors, or refetching only some pages can cause gaps, duplicates, or a visible list that diverges from the server. Check those conditions before choosing a query cache, screen-owner state, or another mechanism. An infinite query may refetch pages sequentially from the first page to preserve cursor continuity when its library and server contracts support that behavior.

```tsx
// Check the server and query contract before caching a volatile cursor-paged list.
const { data } = useInfiniteQuery({
  queryKey: ['records', accountId],
  queryFn: ({ pageParam }) => fetchRecords(accountId, pageParam),
  getNextPageParam: (last) => last.nextId,
})

// A screen owner may use local state when the visible snapshot needs that contract.
const [records, setRecords] = useState<Record[]>([])
const [nextId, setNextId] = useState<string | undefined>()

const loadMore = async () => {
  const result = await fetchRecords(accountId, nextId)
  setRecords(prev => [...prev, ...result.items])
  setNextId(result.nextId)
}
```

## Custom Hook Responsibility

A `use*` function can compose React state, effects, refs, Context, query, form, or event translation when its responsibility and owner are traceable. Pure calculations usually belong in ordinary functions, but a hook is not rejected from its name or return shape alone. A hook that uses `useContext` to expose a shared dispatch is a standard hook composition.

`useState` inside a custom hook creates a separate state instance for each caller. Calling the same stateful hook from multiple components does not share state. When shared state is required, call the hook once in the nearest common owner and pass data through props or callbacks, or move the state into Context or an external store.

Returning JSX from a hook is not by itself a defect. Inspect whether the hook hides an operation owner, creates an opaque or duplicate side effect, or breaks a display contract.

## Props Type Placement and Hook Boundaries

Props types that belong to a single component should generally live in the same file as that component. Separate type files are appropriate when the contract is shared by multiple components, is part of a public API, or has independent meaning as a domain model. A hook should return state, events, and derived values without importing a component's private Props type; the caller can map those values to component props.

```tsx
// Avoid: the hook depends on a specific component's Props contract
import type { DialogProps } from './Dialog'

export function useDialog(): { dialogProps: DialogProps } {
  return { dialogProps: { open, onOpenChange } }
}

// Example: component-local Props stay with the component
interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function Dialog(props: DialogProps) {
  return <Modal {...props} />
}

// Example: the hook returns UI state and operations, and the caller passes them to the component
const dialog = useDialog()
return <Dialog open={dialog.open} onOpenChange={dialog.setOpen} />
```

## Handling exhaustive-deps

Do not add an empty dependency list or a lint suppression as a routine way to silence the linter. First make the Effect's synchronization target and reactive conditions explicit; use an empty list only after changing the code so it reads no reactive values and the mount contract is true. A reactive Effect that should rerun must not be frozen with an empty dependency list.

## Official References

- React: Removing Effect Dependencies
  https://react.dev/learn/removing-effect-dependencies
- React: Extracting State Logic into a Reducer
  https://react.dev/learn/extracting-state-logic-into-a-reducer
- React: Scaling Up with Reducer and Context
  https://react.dev/learn/scaling-up-with-reducer-and-context
- TanStack Query: Infinite Queries
  https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
