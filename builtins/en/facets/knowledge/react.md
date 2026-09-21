# React Knowledge

Apply React props, state, Context, reducers, Effects, and hooks to the GUI hierarchy and state transitions. Idiomatic React and strict MVP Passive View are different concepts, but both can express a boundary between display components and the screen or region logic that arbitrates behavior. A React component hierarchy is logical: a Portal may change DOM placement while state ownership, Context, and event paths remain traceable through that logical hierarchy.

## Props and state ownership

Props are inputs from a parent. State is memory held by a component and changed by operations. Each fact has one owner. In React, `useState` or `useReducer` holds state; a reducer computes the next state from current state and an event; Context distributes values and operation entries.

| State nature | React placement |
|--------------|-----------------|
| Focus, open/close, and in-progress input confined to one component | The component's `useState` or `useReducer` |
| Selection or input shared by siblings | The smallest common parent, passed with props and event handlers |
| One value and operation distributed through a deep subtree | Context distributes them; the Provider or another owner holds state |
| State and transitions arbitrated in one place | `useReducer`, dispatch, or a screen hook |
| Server data and refetch | A query hook or data owner handles conditions, failure, and updates |

### One owner for shared selection

When a list and detail view show one selection, keep the selection in their common parent. If each child keeps `selectedId`, one side can update while the other remains stale and synchronization Effects appear.

```tsx
// Bad: two components keep the same selection separately
function List() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemList selectedId={selectedId} onSelect={setSelectedId} />
}

function Detail() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemDetail id={selectedId} onSelect={setSelectedId} />
}

// Good: the common parent owns the selection and distributes display and intent
function Workspace() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return (
    <>
      <ItemList selectedId={selectedId} onSelect={setSelectedId} />
      <ItemDetail id={selectedId} />
    </>
  )
}
```

When the selection owner changes, review the list operation, detail display, and URL or communication paths that react to the selection as one change.

## Prop changes and state lifetime

Copying a prop into initial state reads it only during the first render. Decide whether the component is controlled by the parent's changing value or owns an editing draft that resets when its identity changes.

```tsx
// Bad: a changed documentTitle does not replace the initial draft
function TitleEditor({ documentTitle }: { documentTitle: string }) {
  const [draft, setDraft] = useState(documentTitle)
  return <input aria-label="Document title" value={draft} onChange={event => setDraft(event.target.value)} />
}

// Good: the parent owns the value while it is edited
function TitleEditor({ title, onChange }: {
  title: string
  onChange: (title: string) => void
}) {
  return <input aria-label="Document title" value={title} onChange={event => onChange(event.target.value)} />
}
```

When a local draft is required, express the document identity that resets it through a component `key` boundary or an explicit reset operation. An unconditional Effect that copies props into state can overwrite user input.

## Derived values and duplicate state

Compute values that follow from props or state during rendering instead of storing them as another state. Synchronizing derived state with an Effect can show one stale render and make update order affect submitted values.

```tsx
// Bad: visibleItems and allSelected are synchronized as canonical state
const [visibleItems, setVisibleItems] = useState<Item[]>([])
const [allSelected, setAllSelected] = useState(false)

useEffect(() => {
  const nextVisibleItems = items.filter(item => matches(item, filter))
  setVisibleItems(nextVisibleItems)
  setAllSelected(
    nextVisibleItems.length > 0 && nextVisibleItems.every(item => selectedIds.has(item.id)),
  )
}, [items, filter, selectedIds])

// Good: derive the same condition from canonical state
const visibleItems = items.filter(item => matches(item, filter))
const allSelected = visibleItems.length > 0 && visibleItems.every(item => selectedIds.has(item.id))
```

When measured computation cost requires reuse, `useMemo` can make dependencies and the result contract explicit. Small computations and values with no matching dependency need no mechanical memoization.

## Context distributes values

Context provides a path to pass values into a deep subtree. Context itself holds no state and arbitrates no transition. A Provider's `useState`, `useReducer`, or external store holds state; Context distributes the state and operation entry.

```tsx
const CartContext = createContext<CartContextValue | null>(null)

function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, initialCart)
  return (
    <CartContext.Provider value={{ state, dispatch }}>
      {children}
    </CartContext.Provider>
  )
}

function CartTotal() {
  const context = useContext(CartContext)
  if (!context) throw new Error('CartTotal must be inside CartProvider')
  return <output>{formatTotal(context.state.items)}</output>
}
```

Putting screen-specific communication procedures or several canonical states into Context makes the operation that changes each state hard to trace. Distribute the values and operations required by deep components, and keep transition and side-effect arbitration in a readable Provider reducer or screen hook.

## Reducer and screen state machine

`useReducer` creates a boundary that computes the next state from current state and operation intent. It is one React realization of a screen or region Mediator and does not require a special class. Display components receive display values and intent entries rather than understanding the reducer.

```tsx
type Phase = 'editing' | 'submitting' | 'success' | 'failure'
type State = { phase: Phase; message: string | null }
type Event =
  | { type: 'submit' }
  | { type: 'retry' }
  | { type: 'completed' }
  | { type: 'failed'; message: string }

const initialState: State = { phase: 'editing', message: null }

function reducer(state: State, event: Event): State {
  if (event.type === 'submit' && state.phase === 'editing') {
    return { phase: 'submitting', message: null }
  }
  if (event.type === 'retry' && state.phase === 'failure') {
    return { phase: 'submitting', message: null }
  }
  if (event.type === 'completed' && state.phase === 'submitting') {
    return { phase: 'success', message: 'Saved' }
  }
  if (event.type === 'failed' && state.phase === 'submitting') {
    return { phase: 'failure', message: event.message }
  }
  return state
}

function SaveView({ state, onSave, onRetry }: {
  state: State
  onSave: () => void
  onRetry: () => void
}) {
  return (
    <section>
      {state.message && <p role="status">{state.message}</p>}
      <SaveButton disabled={state.phase !== 'editing'} onSave={onSave} />
      {state.phase === 'failure' && <RetryButton onRetry={onRetry} />}
    </section>
  )
}
```

This excerpt shows transitions and rendering. The screen holds state with `useReducer(reducer, initialState)`. Its operation handler checks the current state before starting a save, dispatches completion or failure, and passes state and handlers to `SaveView`. The reducer purely returns the next state; the display component handles rendering parameters and intent notification. Multiple operation entries share the same save handler.

## Duplicate submit and multiple operation entries

Form submission, button clicks, and Enter can reach one operation. Calling communication from each entry can submit one intent twice. Use one form submission entry; a submit button uses `type="submit"`, and the current state decides whether submission is accepted.

```tsx
// Bad: click and submit call the same communication twice
<form onSubmit={submitOrder}>
  <button type="submit" onClick={submitOrder}>Place order</button>
</form>

// Good: only form submit dispatches the operation
<form onSubmit={event => {
  event.preventDefault()
  dispatch({ type: 'submit' })
}}>
  <button type="submit" disabled={state.phase === 'submitting'}>Place order</button>
</form>
```

Put all entries into the same reducer, command, or screen hook and let current state accept or reject the intent.

## Effect and external synchronization

Use `useEffect` to synchronize with systems outside rendering: connections, subscriptions, timers, and external APIs. A one-time user operation such as submission belongs in an event handler or command.

Props, state, values, and functions created in a component that an Effect reads determine its re-execution conditions. Decide the synchronized target and rerun reason before editing dependencies.

```tsx
// Bad: a changed roomId leaves the old room connected
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [])

// Good: reconnect per room and release the previous connection
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [roomId, onMessage])
```

If a render-created `onMessage` causes unnecessary reconnections, organize the handler responsibility, move it to a stable reference or outside the Effect, or move the work to an event. Removing the dependency while accepting stale values changes the contract.

### Communication and cleanup

When a URL or identifier changes, include it in dependencies and cancel the previous request. Keep failure distinct from an empty result.

```tsx
useEffect(() => {
  const controller = new AbortController()
  setResult({ status: 'loading' })

  void loadDocument(documentId, controller.signal)
    .then(document => setResult({ status: 'success', document }))
    .catch(error => {
      if (error.name !== 'AbortError') setResult({ status: 'error', error })
    })

  return () => controller.abort()
}, [documentId])
```

When initial loading is truly one-time, structure the Effect so it reads no reactive values. When filter, URL, paging, or explicit refetch is part of the contract, reflect it in dependencies, a query key, or an operation input. Loading labels and dialog visibility are not initial-load conditions.

## Custom hooks

A custom hook can combine React state, Effects, refs, Context, queries, forms, and event translation at a boundary whose responsibility is traceable from the caller. Stateful UI control belongs in the hook and pure calculation in an ordinary function when that makes the screen Mediator and display boundary clearer.

Calling the same stateful hook from multiple components creates separate state. For shared state, call it once in the smallest common component and pass the result through props/callbacks, or place state in a Provider or external store.

```tsx
// Bad: assuming the same hook call shares state
function List() {
  const selection = useSelection()
  return <ItemList selection={selection} />
}

function Detail() {
  const selection = useSelection()
  return <ItemDetail selection={selection} />
}

// Good: one owner calls the hook and passes the result to both components
function Workspace() {
  const selection = useSelection()
  return (
    <>
      <ItemList selection={selection} />
      <ItemDetail selection={selection} />
    </>
  )
}
```

Do not choose a design from a hook's JSX or props-like return shape alone. Review actual screen-specific communication hidden by the hook, duplicate side effects, and circular dependency with a screen-specific component or type.

## TanStack Query and cache conditions

With TanStack Query, include every condition that changes the result in both `queryKey` and `queryFn`. Omitting a key condition conditionally can place different users, URLs, or filters in one cache entry.

```tsx
import { useQuery } from '@tanstack/react-query'

// Bad: accountId disappears when there is no filter
const result = useQuery({
  queryKey: ['orders', filter ? { accountId, filter, page } : { page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})

// Good: every retrieval condition is always part of the key
const result = useQuery({
  queryKey: ['orders', { accountId, filter, page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})
```

After an update, use invalidation, refetch, or a contract-compliant cache update so stale data does not remain canonical. For cursor or offset pagination, check continuity, duplicates, gaps, and post-update ordering against the server and query-library contract.

## Props types and hook boundaries

Place a Props type according to its sharing scope, public contract, reason to change, and dependency direction. A type used by one component can stay near its rendering contract. A shared component contract, public API, or independent domain model can live separately.

A hook can return state, events, and derived values for the caller to map into display props. Sharing a Props type is also valid when it avoids circular dependencies and unnecessary screen-specific coupling and follows the same reason to change.

## References

- React: Thinking in React
  https://react.dev/learn/thinking-in-react
- React: Sharing State Between Components
  https://react.dev/learn/sharing-state-between-components
- React: Responding to Events
  https://react.dev/learn/responding-to-events
- React: Passing Data Deeply with Context
  https://react.dev/learn/passing-data-deeply-with-context
- React: useEffect
  https://react.dev/reference/react/useEffect
- React: You Might Not Need an Effect
  https://react.dev/learn/you-might-not-need-an-effect
- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
