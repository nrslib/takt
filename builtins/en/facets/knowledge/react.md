# React Knowledge

## Effects and Re-execution

`useEffect` is a mechanism for declaring when re-execution is allowed, not a generic place to put initialization. Decide first whether a load is mount-only or should rerun on dependency changes.

| Criteria | Judgment |
|----------|----------|
| A mount-only initial load depends on recreated function references | REJECT |
| Context/Provider functions are used as effect dependencies without a clear refetch requirement | REJECT |
| Mount-only initialization is expressed with `useEffect(..., [])` and its intent is documented | OK |
| Refetching on dependency change is required by the feature and those dependencies are explicit | OK |

```tsx
// REJECT - initial load can rerun because unstable function deps leak into the effect
const fetchList = useCallback(async () => {
  await loadItems()
}, [setIsLoading, errorPage])

useEffect(() => {
  fetchList()
}, [fetchList])

// OK - explicitly mount-only initial load
useEffect(() => {
  void loadItemsOnMount()
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## Context and Provider Values

`value={{ ... }}` in a Provider creates a new reference on each Provider render. When functions obtained from Context are placed in effect dependencies, consumers can enter unintended refetch loops.

| Criteria | Judgment |
|----------|----------|
| Context-derived functions are placed in effect dependencies without checking reference stability | REJECT |
| Mount effects rely on Provider functions whose stability is not guaranteed | REJECT |
| Context functions are used from event handlers while initial load stays mount-only | OK |
| Provider values are stabilized and refetch conditions are defined explicitly | OK |

```tsx
// REJECT - Context functions are used directly as initial-load effect deps
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData(setIsLoading, errorPage)
}, [setIsLoading, errorPage])

// OK - initial load is mount-only, Context functions are consumed inside it
const { setIsLoading, errorPage } = useAppContext()
useEffect(() => {
  void loadInitialData({ setIsLoading, errorPage })
  // mount-only initial load
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])
```

## Initial Page Load

Treat initial page load separately from reactive refetching. Unless refetching is required by filter, URL, pagination, or explicit user action, keep the initial fetch mount-only.

| Condition | Recommendation |
|-----------|----------------|
| List is loaded once on page entry | mount-only effect |
| Refetching follows filter, pagination, or URL changes | make those states explicit dependencies |
| Loading state updates trigger refetching | REJECT |
| Message display or dialog state triggers refetching | REJECT |

## Data Fetching Library Cache Suitability

Data fetching library caching (React Query, etc.) is not appropriate for all data. Judge by data volatility and pagination method.

| Data Characteristics | Cache | Verdict |
|---------------------|-------|---------|
| Single resource detail (settings, profile, etc.) | Effective | OK |
| Stable list (master data, low change frequency) | Effective | OK |
| Cursor-paginated list with mid-stream additions, deletions, or reordering | Ineffective | Use local state |
| Offset-paginated list with mid-stream data changes | Ineffective | Use local state |

Why cursor pagination and caching are incompatible:

- The nextId (cursor) goes stale, causing gaps or duplicates when fetching the next page
- Fetching the next page based on a deleted row causes missed records
- Auto-refetching middle pages on tab refocus causes the visible list to diverge from the server's truth

If you need to effectively disable caching even when using a data fetching library, there is no point in using that library. Fetching fresh data each time as the screen's responsibility is safer.

```tsx
// REJECT - applying React Query cache to a volatile cursor-paged list
const { data } = useInfiniteQuery({
  queryKey: ['records'],
  queryFn: ({ pageParam }) => fetchRecords(pageParam),
  getNextPageParam: (last) => last.nextId,
  staleTime: 5 * 60 * 1000,  // caching despite mid-stream deletions
})

// OK - local state fetching as the screen's responsibility
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

| Criteria | Judgment |
|----------|----------|
| A module is named `use*` but does not use React state/effect/ref | Warning |
| Pure functions are modeled as a custom hook | Warning |
| Stateful UI control lives in a custom hook and pure calculations live in functions | OK |
| Multiple components call the same stateful hook independently when they need shared state | REJECT |
| A hook returns JSX | REJECT |

## Handling exhaustive-deps

`react-hooks/exhaustive-deps` is not a rule to satisfy mechanically. If adding dependencies changes a mount-only effect into a loop, keep the effect mount-only and document why the suppression exists.

| Criteria | Judgment |
|----------|----------|
| Dependencies are added only to satisfy lint and they change runtime behavior | REJECT |
| Lint suppression is added without explanation | Warning |
| Mount-only suppression is documented with intent | OK |
| A reactive effect that should rerun is incorrectly frozen with `[]` | REJECT |
