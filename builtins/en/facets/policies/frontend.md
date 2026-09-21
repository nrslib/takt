{extends:gui}

# Frontend Policy

Judge web route reachability, display contracts, data fetching, accessibility, and security through GUI responsibility boundaries and observable impact paths.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Check applicability | Apply criteria only to the original requirement, changed contract, and real impact paths |
| Use evidence | Judge only conditions confirmed by code, contracts, or evidence |
| Preserve ownership boundaries | Distinguish the responsible owner from observable effects |
| Check web boundaries | Verify route, URL, DOM, browser, API, and server boundaries at actual inputs and outputs |
| Preserve display contracts | Check accessible names, roles, states, display units, and the meaning and naturalness of text |
| Preserve data boundaries | Check API clients, fetch scope, cache behavior, and refetch conditions against their contracts |
| Keep scope bounded | Judge only the scope causally related to the request |
| Use consistent grounds | Do not add a judgment criterion from an example that cannot be derived from the original requirement, changed contract, or real impact paths |

## Routing Wiring When Adding a Page

| Criteria | Judgment |
|----------|----------|
| A new page exists but no route is registered | REJECT |
| Basename URL and route path mapping is not verified | REJECT |
| The page, Root hierarchy, responsible owner, Router, and actual entry path are checked as one change contract | OK |
| A temporary development path has its purpose and removal condition recorded | OK |
| Routes are updated but menus, buttons, links, or external callers are not checked | Warning |

## Integrating Third-party UI Libraries

| Criteria | Judgment |
|----------|----------|
| Major UI library props are guessed without checking the project version | REJECT |
| Tests fully mock the library and miss real mount failures | Warning |
| The real component is rendered with representative props and verified not to crash at screen level | OK |
| Prop shapes follow existing usage and the installed project version | OK |

## Accessibility Contracts

| Criteria | Judgment |
|----------|----------|
| A new interactive element has no accessible name | REJECT |
| Checked, expanded, disabled, or similar state is not exposed to assistive technology | Warning |
| An existing accessible name is changed without being required by the task | REJECT |
| A dynamic accessible name is assembled from fragments without checking the final sentence for meaning and naturalness | REJECT |
| Distinct elements in one interaction context cannot be identified by name or programmatic context (row/group association, etc.) | REJECT. Including the target name is a strong identification method |
| Existing accessible names are preserved while missing role/state is added | OK |
| The reason and impact scope for changing an existing contract are explicit | OK |

## State and Derived Values

| Criteria | Judgment |
|----------|----------|
| Unnecessary global state is introduced | Consider localizing |
| Multiple owners keep the same canonical state and cause an observable inconsistency | REJECT. Normalize it in the responsible subtree or shared owner |
| API responses enter canonical state without checking their meaning, identifiers, and display contract | Consider normalization |
| A value always computable from one state is kept as another state | REJECT |
| Invariants between state fields are maintained by effects or manual synchronization | REJECT |
| Display labels, counts, totals, all-selected flags, sorted results, or grouped results are canonical state | REJECT |
| API sending, persistence, or diffing depends on derived state instead of canonical state | REJECT |
| A display-position sequence after filtering, paging, or grouping is treated as source ordering | REJECT. Define the collection whose order the label represents and derive from it |
| Canonical state is kept while display, aggregation, and decisions are derived with selectors, rendering, or memoization | OK |
| Values required by external contracts are derived from canonical state at send or persistence boundaries | OK |

## API Clients and Data Fetching

| Criteria | Judgment |
|----------|----------|
| A generated client exists but axiosInstance or fetch is called directly | REJECT |
| An API hook is handwritten without checking the generator or existing fetch boundary | REJECT |
| No generated client exists and the responsible owner or communication boundary calls the API directly | OK |
| A View calls a query or data-fetching hook while the hook or Provider owns state, communication, and errors | OK |
| A display-only View directly owns fetch conditions, state updates, or communication error arbitration | REJECT |
| Loading, errors, or cancellation are passed to the display without handling | REJECT |
| N+1 query-like fetching is introduced | REJECT |

Do not force all data fetching into the Root. A route, screen owner, or independent widget may fetch when it owns the needed data and consistency contract. Verify the result boundary and operation path.

## Initial Load and Refetch

| Criteria | Judgment |
|----------|----------|
| Initial loading reruns only because a Provider/Context function identity changed | REJECT |
| Refetch conditions are defined as URL, filter, paging, explicit refresh operations, or a query/library/server contract | OK |
| Message display, loading changes, or dialog open/close alone trigger unrelated refetching | REJECT |
| The contract makes initial loading mount-only and later refetches use explicit triggers or declared query conditions | OK |
| Initial loading and later refetches are separate events and transitions | OK |
| A reactive value is omitted or added only to satisfy lint rather than the intended synchronization | REJECT |

## Cache and Pagination

Do not decide cache suitability from the word cursor or offset alone. Check query keys, invalidation, refetching, page continuity, duplicates, gaps, and the visible snapshot against the server and library contracts.

| Criteria | Judgment |
|----------|----------|
| A query key omits URL, filters, paging, user, tenant, or another data identity condition and shares different data | REJECT |
| No invalidation, refetch, or contract-compliant cache update exists after updates, leaving stale data as canonical display | REJECT |
| Cursor or offset refetching lacks a contract for page consistency, duplicates, or gaps | REJECT |
| Pages are fetched and refetched according to the query or infinite-query contract | OK |
| A query cache is prohibited solely because the data uses cursor or offset pagination | Not a reason to reject |

## Independent Widgets and Communication Scope

| Criteria | Judgment |
|-----------|----------|
| A widget accepts URL, id, or filter values as public inputs, matches query identity (query key or dependencies) and invalidation/refetch or another update contract to those inputs, does not duplicate the parent's canonical state, and owns its subtree | OK |
| A widget hides communication that reads the parent URL, id, filter, permission, or state implicitly, or duplicates the same canonical state in another query/state without a contract | REJECT |
| Communication needed by the visible tab or screen is owned within that subtree | OK |
| A shared parent fetches for every tab and distributes data to hidden tabs | REJECT |
| Polling or subscriptions continue for a hidden tab | REJECT |

## Screen-Specific API Usage

| Criteria | Judgment |
|----------|----------|
| A list response is reused as canonical detail-screen data | REJECT |
| Display units and API fetch units do not match | REJECT |
| All records are fetched only to make a decision when an aggregation API is appropriate | REJECT |
| A concept the UI needs is missing from the response and a semantically different body/description is implicitly reused as a heading | REJECT. Define an explicit summary/fallback display contract or add a dedicated field |
| Each screen has a dedicated fetch boundary returning the needed data | OK |

## Display Format and Web Boundaries

| Criteria | Judgment |
|----------|----------|
| The backend returns display strings that lose locale or context | Suggest design review |
| The same formatting logic is copied across components | Unify it in a utility |
| Formatting is performed inline in a component | Extract it to a function |
| Component formatting with a different display contract is reused for operations or persistence | REJECT |
| Route, URL, DOM, browser API, and server API boundaries have explicit input and output contracts | OK |

## Frontend and Backend Responsibility

| Criteria | Judgment |
|----------|----------|
| Price calculation, stock validation, or business status transitions are finalized in the frontend | REJECT. The backend remains authoritative |
| Frontend-only business validation is treated as complete | REJECT |
| A value that the server can calculate is recalculated in the frontend | Redundant; REJECT |
| Server display state is formatted and UI operations are sent as commands | OK |
| UI-only required-field checks, display filters, and previews are handled client-side while the server validates when needed | OK |

## Performance, Types, Security, and Tests

| Criteria | Judgment |
|----------|----------|
| Unnecessary rerenders | Needs optimization |
| Large lists without virtualization | Warning |
| Unoptimized images | Warning |
| Unused code in the bundle | Check tree-shaking |
| Excessive memoization | Verify necessity |
| The any type is used | REJECT |
| Type assertions are overused without checking the contract | Needs review |
| Props have no type definition | REJECT |
| An event handler has an inappropriate type | Needs fix |
| An interactive element lacks keyboard support | REJECT |
| An image lacks alt | REJECT |
| A form control lacks a label | REJECT |
| Information is conveyed by color alone | REJECT |
| Focus management is missing for a modal or similar interaction | REJECT |
| dangerouslySetInnerHTML is used without checking the XSS risk | Check XSS risk |
| User input reaches the DOM without sanitization | REJECT |
| Sensitive data is stored in the frontend | REJECT |
| A CSRF token is missing where the boundary requires it | Needs verification |
| data-testid or equivalent is absent and the change reduces verifiability | Warning |
| The structure is hard to test and the responsibility path cannot be checked | Consider separation |
| Business logic is embedded in the UI | REJECT |
| State and operation paths are tested only through View rendering without checking real mounting or API boundaries | Warning |

## Native Events and Application Operations

| Criteria | Judgment |
|----------|----------|
| DOM capture/bubble, default action, and an application callback execute the same operation twice | REJECT |
| An implementation is rejected only because it does not call stopPropagation for every DOM event | Not a reason to reject |
| Native event propagation is distinguished from the application intent path to a state owner | OK |

## Anti-Pattern Detection

| Pattern | Judgment |
|---------|----------|
| God Component | REJECT when unrelated features and side effects are concentrated so ownership and change impact cannot be traced |
| Prop Drilling | REJECT when a deep props bucket brigade hides ownership or operation meaning; pass-through props and callbacks are not defects by depth alone |
| Inline Styles abuse | REJECT: it damages maintainability and theme contracts |
| useEffect hell | REJECT: effects accumulate overly complex dependencies |
| Premature Optimization | REJECT: memoization is added without a current need |
| Magic Strings | REJECT: meaningful strings are hardcoded |
| Hidden Dependencies | REJECT: child components make hidden API calls |
| Over-generalization | REJECT: components are forced to be generic without a contract need |
