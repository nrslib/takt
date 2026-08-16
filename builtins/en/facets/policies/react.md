# React Policy

Provide one source of truth for independent judgments about react.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply the policy only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Centralize judgment | This policy is authoritative; Knowledge examples do not grant judgment authority |

## React Criteria

### Effects and Re-execution

| Criteria | Judgment |
|----------|----------|
| A mount-only initial load depends on recreated function references | REJECT |
| Context/Provider functions are used as effect dependencies without a clear refetch requirement | REJECT |
| Mount-only initialization is expressed with `useEffect(..., [])` and its intent is documented | OK |
| Refetching on dependency change is required by the feature and those dependencies are explicit | OK |

### Context and Provider Values

| Criteria | Judgment |
|----------|----------|
| Context-derived functions are placed in effect dependencies without checking reference stability | REJECT |
| Mount effects rely on Provider functions whose stability is not guaranteed | REJECT |
| Context functions are used from event handlers while initial load stays mount-only | OK |
| Provider values are stabilized and refetch conditions are defined explicitly | OK |

### Initial Page Load

| Criteria | Judgment |
|----------|----------|
| A mount-only list load is retriggered by loading-state updates | REJECT |
| A mount-only list load is retriggered by message display or dialog toggles | REJECT |
| The initial load is mount-only and later refetch conditions are explicit | OK |

### Data Fetching Library Cache Suitability

| Data Characteristics | Cache | Verdict |
|---------------------|-------|---------|
| Single resource detail (settings, profile, etc.) | Effective | OK |
| Stable list (master data, low change frequency) | Effective | OK |
| Cursor-paginated list with mid-stream additions, deletions, or reordering | Ineffective | Use local state |
| Offset-paginated list with mid-stream data changes | Ineffective | Use local state |

### Custom Hook Responsibility

| Criteria | Judgment |
|----------|----------|
| A module is named `use*` but does not use React state/effect/ref | Warning |
| Pure functions are modeled as a custom hook | Warning |
| Stateful UI control lives in a custom hook and pure calculations live in functions | OK |
| Multiple components call the same stateful hook independently when they need shared state | REJECT |
| A hook returns JSX | REJECT |

### Props Type Placement and Hook Boundaries

| Criteria | Judgment |
|----------|----------|
| A single component's private Props type is moved to a `types` file without a clear reason | Warning |
| Props are moved to a separate file only so a hook can import a component's Props type | REJECT |
| Shared Props/data contracts used by multiple components or public APIs live in a separate file | OK |
| A hook returns state, events, and derived values while a container maps them to component props | OK |
| Even when a hook returns a props-like object, the hook does not depend on the component's Props type | OK |

### Handling exhaustive-deps

| Criteria | Judgment |
|----------|----------|
| Dependencies are added only to satisfy lint and they change runtime behavior | REJECT |
| Lint suppression is added without explanation | Warning |
| Mount-only suppression is documented with intent | OK |
| A reactive effect that should rerun is incorrectly frozen with `[]` | REJECT |
