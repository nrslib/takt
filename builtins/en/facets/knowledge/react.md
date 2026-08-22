# React Knowledge

## Effects and Re-execution

`useEffect` is a mechanism for declaring when re-execution is allowed, not a generic place to put initialization. Decide first whether a load is mount-only or should rerun on dependency changes.


```tsx
// Avoid: initial load can rerun because unstable function deps leak into the effect
const fetchList = useCallback(async () => {
  await loadItems()
}, [setIsLoading, errorPage])

useEffect(() => {
  fetchList()
}, [fetchList])

// Example: explicitly mount-only initial load
useEffect(() => {
  void loadItemsOnMount()
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## Context and Provider Values

`value={{ ... }}` in a Provider creates a new reference on each Provider render. When functions obtained from Context are placed in effect dependencies, consumers can enter unintended refetch loops.


```tsx
// Avoid: Context functions are used directly as initial-load effect deps
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData(setIsLoading, errorPage)
}, [setIsLoading, errorPage])

// Example: initial load is mount-only, Context functions are consumed inside it
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData({ setIsLoading, errorPage })
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## Initial Page Load

Treat initial page load separately from reactive refetching. Unless refetching is required by filter, URL, pagination, or explicit user action, keep the initial fetch mount-only.

| Condition | Behavior |
|-----------|----------|
| List is loaded once on page entry | mount-only effect |
| Refetching follows filter, pagination, or URL changes | make those states explicit dependencies |
| Loading, message, or dialog state changes | keep separate from initial-load triggers |

## Data Fetching Library Cache Suitability

Data fetching library caching (React Query, etc.) is not appropriate for all data. Judge by data volatility and pagination method.


Why cursor pagination and caching are incompatible:

- The nextId (cursor) goes stale, causing gaps or duplicates when fetching the next page
- Fetching the next page based on a deleted row causes missed records
- Auto-refetching middle pages on tab refocus causes the visible list to diverge from the server's truth

If you need to effectively disable caching even when using a data fetching library, there is no point in using that library. Fetching fresh data each time as the screen's responsibility is safer.

```tsx
// Avoid: applying React Query cache to a volatile cursor-paged list
const { data } = useInfiniteQuery({
  queryKey: ['records'],
  queryFn: ({ pageParam }) => fetchRecords(pageParam),
  getNextPageParam: (last) => last.nextId,
  staleTime: 5 * 60 * 1000,  // caching despite mid-stream deletions
})

// Example: local state fetching as the screen's responsibility
const [records, setRecords] = useState<Record[]>([])
const [nextId, setNextId] = useState<string | undefined>()

const loadMore = async () => {
  const result = await fetchRecords(nextId)
  setRecords(prev => [...prev, ...result.items])
  setNextId(result.nextId)
}
```

## Custom Hook Responsibility

A React custom hook should encapsulate state, effects, refs, or event translation. Pure calculations belong in function modules, not in a `use*` hook.
`useState` inside a custom hook creates a separate state instance for each caller. Calling the same hook from multiple components does not share state.
When shared state is required, call the hook once in the nearest common parent and pass data through props, or move the state into Context/external store.


### Props Type Placement and Hook Boundaries

Props types that belong to a single component should generally live in the same file as that component. Separate type files are appropriate when the contract is shared by multiple components, is part of a public API, or has independent meaning as a domain model.


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

`react-hooks/exhaustive-deps` is not a rule to satisfy mechanically. If adding dependencies changes a mount-only effect into a loop, keep the effect mount-only and document why the suppression exists.
