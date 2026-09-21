# React Knowledge

In React, parents pass values through props, components keep changing values in state, and rendering creates the screen. Put screen communication and navigation in handlers or hooks rather than inside display components.

## Props and state

Props are inputs passed by a parent; state is a value a component changes through interaction. Do not keep the same fact in two `useState` calls. Keep it where its scope and lifetime fit.

```tsx
// NG - the list and detail view keep separate selections
function List() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemList selectedId={selectedId} onSelect={setSelectedId} />
}

function Detail() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return <ItemDetail id={selectedId} onSelect={setSelectedId} />
}

// OK - one common parent owns the selection
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

If an in-progress value or open/closed state is used by one component, keep it there. If several components use a selection or input, keep it in their common parent. Keep a value that should survive screen changes in a Provider or external store that survives those changes.

## Prop changes and state lifetime

The initial value passed to `useState` is not copied into state again when props change. An input that continues to display the parent's value should receive the value and change callback as props.

```tsx
// NG - shows the first draft even after documentTitle changes
function TitleEditor({ documentTitle }: { documentTitle: string }) {
  const [draft, setDraft] = useState(documentTitle)
  return (
    <input
      aria-label="Document title"
      value={draft}
      onChange={event => setDraft(event.target.value)}
    />
  )
}

// OK - displays the parent's value and reports changes to the parent
function TitleEditor({ title, onChange }: {
  title: string
  onChange: (title: string) => void
}) {
  return (
    <input
      aria-label="Document title"
      value={title}
      onChange={event => onChange(event.target.value)}
    />
  )
}
```

A draft that should not reach the parent until it is confirmed can stay in the component's state. When switching to another document, use the document ID as `key` to create a new instance, or reset the state as part of the switch. Copying props into state in an Effect can overwrite a value that is being edited.

## Compute derived values

Do not store in state a value that can be calculated from props or state. Syncing a derived value with an Effect can show an old value just after an update or make a decision depend on update order.

```tsx
// NG - store the visible list and all-selected result in separate state via an Effect
const [visibleItems, setVisibleItems] = useState<Item[]>([])
const [allSelected, setAllSelected] = useState(false)

useEffect(() => {
  const next = items.filter(item => matches(item, filter))
  setVisibleItems(next)
  setAllSelected(next.length > 0 && next.every(item => selectedIds.has(item.id)))
}, [items, filter, selectedIds])

// OK - calculate both from the same condition each time
const visibleItems = items.filter(item => matches(item, filter))
const allSelected = visibleItems.length > 0
  && visibleItems.every(item => selectedIds.has(item.id))
```

If the amount of computation is an actual problem, reuse it with `useMemo` or a similar mechanism. Use it when you can explain which dependencies allow the computation to be skipped.

## Context passes values

Context lets descendants read a value provided by an ancestor's Provider. A Provider can use `useState` or `useReducer` and pass the state and its update function.

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

Passing a save function through Context lets a deep child call the same save operation. The reducer calculates state, and the passed function starts communication.

## Reducers and save communication

A reducer is a pure function that returns the next state from the current state and an event. A handler starts save communication and dispatches at start, success, and failure. The reducer does not perform communication or notifications.

## Prevent duplicate submits

The following is a form that receives `onSave`. It uses form submission as the one entry point; the button's click path does not call `onSave`.

```tsx
function SaveForm({ disabled, onSave }: {
  disabled: boolean
  onSave: () => void
}) {
  return (
    <form onSubmit={event => {
      event.preventDefault()
      if (!disabled) onSave()
    }}>
      <button type="submit" disabled={disabled}>Save</button>
    </form>
  )
}
```

An Enter key or another entry into the form also reaches submit, so the save is reported once.

Even when a portal places a part elsewhere in the DOM, its React events propagate to ancestors along the React tree.

## Effects and external systems

`useEffect` synchronizes React with connections, subscriptions, timers, fetches, and other systems outside rendering. A save or notification caused by one user operation belongs in an event handler or command, not in an Effect.

Include props, state, and variables or functions declared inside the component that the Effect reads in its dependency array. Define what is being synchronized, such as recreating a connection when its room changes.

```tsx
// NG - keeps using the old room connection after roomId changes
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [])

// OK - connects for each room and closes before rerunning and on unmount
useEffect(() => {
  const connection = connectToRoom(roomId)
  connection.subscribe(onMessage)
  return () => connection.close()
}, [roomId, onMessage])
```

If a callback reference changes on every render and actually causes unnecessary reconnections, stabilize the handler, move it outside the Effect, or move the work to event handling. Do not remove a dependency and make the Effect use an old value.

When an identifier change should start a new fetch, include the identifier in the dependencies and cancel the previous fetch in cleanup. Do not turn an aborted result into a failure message.

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

## React execution rules

Call Hooks at the top level of a component or custom Hook, never inside a condition or loop. During rendering, do not communicate, notify, manipulate the DOM, change an external variable, or mutate props and state directly.

In a reorderable list, use the item's ID as `key` instead of the array index. When a `key` changes, React treats the element as a different component and resets its state.

## Custom Hooks

A custom Hook can group state, Effects, refs, Context, queries, forms, and event conversion as one screen behavior. Put pure calculations in a regular function.

State created by `useState` inside a Hook is separate for each call to that Hook. A Hook that reads Context, a query, or an external store can return shared values, so determine sharing from what the Hook reads and writes rather than its name.

## TanStack Query and cache

With TanStack Query, pass conditions that change the result with the same meaning to `queryKey` and `queryFn`. Omitting a key item for some conditions puts another user's or filter's result in the same cache.

```tsx
import { useQuery } from '@tanstack/react-query'

// NG - removes accountId from the key when there is no filter
const result = useQuery({
  queryKey: ['orders', filter ? { accountId, filter, page } : { page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})

// OK - always includes the fetch conditions in the same key
const result = useQuery({
  queryKey: ['orders', { accountId, filter, page }],
  queryFn: () => fetchOrders({ accountId, filter, page }),
})
```

After an update, replace stale results with invalidation, a refetch, or a TanStack Query cache update. In a paged list, ensure that the cursor, sort, filter, and snapshot match the server result and that duplicates and gaps are handled.

## Props types and Hook placement

Keep a Props type used by one component near that component. Put a type used by several parts where it can be shared. A screen Hook can return the values and operation functions needed for display, and the component can render from them.

## References

- React: Thinking in React
  https://react.dev/learn/thinking-in-react
- React: Sharing State Between Components
  https://react.dev/learn/sharing-state-between-components
- React: Responding to Events
  https://react.dev/learn/responding-to-events
- React: Passing Data Deeply with Context
  https://react.dev/learn/passing-data-deeply-with-context
- React: Reusing Logic with Custom Hooks
  https://react.dev/learn/reusing-logic-with-custom-hooks
- React: useEffect
  https://react.dev/reference/react/useEffect
- React: You Might Not Need an Effect
  https://react.dev/learn/you-might-not-need-an-effect
- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
