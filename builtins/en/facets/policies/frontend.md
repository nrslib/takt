# Frontend Policy

Provide one source of truth for independent judgments about frontend.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply these criteria only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Keep the scope bounded | Judge only the scope causally related to the request |
| Use consistent grounds | Do not add a judgment criterion from an example that cannot be derived from the original requirement, changed contract, or real impact paths |

## Frontend Criteria

### Routing Wiring When Adding a Page

| Criteria | Judgment |
|----------|----------|
| A new page exists but no route is registered for it | REJECT |
| Basename-based URL and route path mapping is not verified | REJECT |
| Router wiring and page entry are decided together with the page implementation | OK |
| A temporary development route is used and its purpose/removal plan is recorded | OK |
| Routes are updated but actual entry points such as menus, buttons, links, or external callers are not checked | Warning |

### Integrating third-party UI libraries

| Criteria | Judgment |
|----------|----------|
| Major UI library props are guessed without checking the version used by the project | REJECT |
| Tests fully mock the library and miss real mount failures | Warning |
| The real component is rendered with representative props and verified not to crash at screen level | OK |
| Prop shapes are chosen by referencing existing in-project usage patterns and the installed version | OK |

### Accessibility Contracts

| Criteria | Judgment |
|----------|----------|
| A new interactive element has no accessible name | REJECT |
| Checked, expanded, disabled, or similar state is not exposed to assistive technologies | Warning |
| An existing accessible name is changed without being required by the task | REJECT |
| A dynamic accessible name is assembled by concatenating fragments without checking the final sentence for meaning and naturalness | REJECT |
| Distinct elements in the same interaction context cannot be identified by name or programmatic context (row/group association, etc.) | REJECT. Including the target name in the accessible name is a strong way to identify it |
| Existing accessible names are preserved while missing role/state is added | OK |
| The reason and impact scope for changing an existing contract are explicit | OK |

### State Management

| Criteria | Judgment |
|----------|----------|
| Unnecessary global state | Consider localizing |
| Same state managed in multiple places | REJECT. Normalize it in the nearest common parent or shared store |
| State changes from child to parent (reverse data flow) | REJECT |
| API response stored as-is in state | Consider normalization |
| Inappropriate useEffect dependencies | REJECT |
| Initial load tied to unstable Context/Provider function references | REJECT |

### Canonical and Derived State

| Criteria | Judgment |
|----------|----------|
| A value that can always be computed from one state is kept as another state | REJECT |
| Multiple state fields have invariants that require constant synchronization | REJECT |
| Display labels, counts, totals, all-selected flags, sorted results, or grouped results are kept as canonical state | REJECT |
| API sending, persistence, or diffing depends on derived state instead of canonical state | REJECT |
| A display-position sequence number after filtering, paging, or grouping is treated as the ordering of the source data | REJECT. Define which collection's order the label represents and derive it from that collection |
| Only canonical state is stored, and display, aggregation, and decisions are derived via selectors, render logic, or useMemo | OK |
| Derived values required by external contracts are generated from canonical state at send or persistence boundaries | OK |

### Initial load and refetch boundaries

| Criteria | Judgment |
|----------|----------|
| Initial load reruns because a Provider/Context callback changed identity | REJECT |
| Refetch conditions are explicit (URL, filter, paging, refresh action) | OK |
| Message display, loading toggles, or modal state cause refetching | REJECT |
| Initial load is mount-only and later refetches are triggered explicitly | OK |

### Data Fetching

| Criteria | Judgment |
|----------|----------|
| Direct fetch in component | Separate to Container layer |
| No error handling | REJECT |
| Loading state not handled | REJECT |
| N+1 query-like fetching | REJECT |

### Screen-Specific API Usage

| Criteria | Judgment |
|----------|----------|
| Reusing list API response for detail screen | REJECT |
| Display unit and API fetch unit mismatch | REJECT |
| Fetching all records just for a decision (should use aggregation API) | REJECT |
| A concept the UI needs is missing from the response, and a semantically different body/description field is implicitly repurposed as a heading | REJECT. Define the summary/fallback as an explicit display contract, or add a dedicated field |
| Each screen has dedicated fetch endpoints returning only needed data | OK |

### Communication Scope Limitation

| Criteria | Judgment |
|----------|----------|
| Only visible tab communicates on tab switch | OK |
| Parent fetches for all tabs and distributes to children | REJECT |
| Polling continues on hidden tabs | REJECT |

### Display Format Responsibility

| Criteria | Judgment |
|----------|----------|
| Backend returns display strings | Suggest design review |
| Same format logic copy-pasted | Unify to utility function |
| Inline formatting in component | Extract to function |

### Domain Logic Placement (Smart UI Elimination)

| Criteria | Judgment |
|----------|----------|
| Price calculation/stock validation in frontend | Move to backend → **REJECT** |
| Status transition rules in frontend | Move to backend → **REJECT** |
| Business validation in frontend | Move to backend → **REJECT** |
| Recalculating server-computable values in frontend | Redundant → **REJECT** |

### Performance

| Criteria | Judgment |
|----------|----------|
| Unnecessary re-renders | Needs optimization |
| Large lists without virtualization | Warning |
| Unoptimized images | Warning |
| Unused code in bundle | Check tree-shaking |
| Excessive memoization | Verify necessity |

### Accessibility

| Criteria | Judgment |
|----------|----------|
| Interactive elements without keyboard support | REJECT |
| Images without alt attribute | REJECT |
| Form elements without labels | REJECT |
| Information conveyed by color only | REJECT |
| Missing focus management (modals, etc.) | REJECT |

### TypeScript/Type Safety

| Criteria | Judgment |
|----------|----------|
| Use of `any` type | REJECT |
| Excessive type assertions (as) | Needs review |
| No Props type definition | REJECT |
| Inappropriate event handler types | Needs fix |

### Frontend Security

| Criteria | Judgment |
|----------|----------|
| dangerouslySetInnerHTML usage | Check XSS risk |
| Unsanitized user input | REJECT |
| Sensitive data stored in frontend | REJECT |
| CSRF token not used | Needs verification |

### Testability

| Criteria | Judgment |
|----------|----------|
| No data-testid, etc. | Warning |
| Structure difficult to test | Consider separation |
| Business logic embedded in UI | REJECT |

## Anti-Pattern Detection

| Pattern | Decision |
|---------|----------|
| God Component | REJECT: all features are concentrated in one component |
| Prop Drilling | REJECT: props are passed through a deep bucket brigade |
| Inline Styles abuse | REJECT: inline styles degrade maintainability |
| useEffect hell | REJECT: effects accumulate overly complex dependencies |
| Premature Optimization | REJECT: memoization is added without a current need |
| Magic Strings | REJECT: meaningful strings are hardcoded |
| Hidden Dependencies | REJECT: child components make hidden API calls |
| Over-generalization | REJECT: components are forced to be generic without a contract need |
