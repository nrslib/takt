# Frontend Knowledge

## Component Design

Choose component boundaries by responsibility, reason to change, reuse boundary, and data ownership rather than line count or the mere presence of state. Independently changing sections and side effects are separation candidates, but closely collaborating presentation should not be split mechanically. Do not introduce state management based on prop depth alone; reconsider ownership when multiple branches share the same state or another real ownership boundary appears.

Good Component:
- Single responsibility: Does one thing well
- Self-contained: Dependencies are clear
- Testable: Side effects are isolated

Component Classification:

| Type | Responsibility | Example |
|------|----------------|---------|
| Container | Data fetching, state management | `UserListContainer` |
| Presentational | Display only | `UserCard` |
| Layout | Arrangement, structure | `PageLayout`, `Grid` |
| Utility | Common functionality | `ErrorBoundary`, `Portal` |

Directory Structure:
```
features/{feature-name}/
├── components/
│   ├── {feature}-view.tsx      # Main view (composes children)
│   ├── {sub-component}.tsx     # Sub-components
│   └── index.ts
├── hooks/
├── types.ts
└── index.ts
```

## Routing Wiring When Adding a Page

Do not stop at creating the page component. A new page must also be wired into an actual entry path. Decide together with the implementation how the page is reached: router, menu, temporary route, or another explicit entry point.


```tsx
// Example: page and route are added together
<Route path="/contreg" element={<ContainerRegisterPage />} />

// Avoid: page exists but has no reachable route
// src/pages/ContainerRegisterPage.tsx exists
// Router has no matching route
```

Reachability is broader than router configuration. Confirm the real entry path users will follow, such as menus, transition buttons, dialog actions, links from other screens, or external callers.

### Integrating third-party UI libraries

Third-party UI libraries such as data grids, date pickers, charts, and virtualized lists can fail at runtime even when types pass. This is especially common across major-version changes where prop names or state model shapes are no longer compatible, and shallow mocks do not expose the problem.


### Accessibility Contracts

Accessible names, roles, and states are UI contracts consumed by assistive technologies and tests. Add appropriate accessibility attributes for new UI elements, but treat changes to existing accessibility contracts like other user-facing copy or behavior changes.


## State Management

Child components do not modify their own state. They bubble events to parent, and parent manipulates state.
When multiple components read or update the same state, first place that state in their nearest common parent, then pass data and event callbacks down through props.

```tsx
// ❌ Child modifies its own state
const ChildBad = ({ initialValue }: { initialValue: string }) => {
  const [value, setValue] = useState(initialValue)
  return <input value={value} onChange={e => setValue(e.target.value)} />
}

// ✅ Parent manages state, child notifies via callback
const ChildGood = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  return <input value={value} onChange={e => onChange(e.target.value)} />
}

const Parent = () => {
  const [value, setValue] = useState('')
  return <ChildGood value={value} onChange={setValue} />
}
```

Exception (OK for child to have local state):
- UI-only temporary state (hover, focus, animation)
- Completely local state that doesn't need to be communicated to parent


### Canonical and Derived State

State should hold canonical values such as user input, server data, and temporary UI state. Display values, aggregates, selection states, sorted results, and grouped results that can be computed from canonical state are derived values and must not be kept as independent state.


State Placement Guidelines:

| State Nature | Recommended Placement |
|--------------|----------------------|
| Temporary UI state (modal open/close, etc.) | Local (useState) |
| Form input values | Local or form library |
| Shared across nearby parent/child or sibling components | Nearest common parent, passed through props |
| Shared across deep hierarchy or multiple screens | Context or state management library |
| Server data cache | Data fetching library (TanStack Query, etc.) |

## Initial load and refetch boundaries

Initial loading should be separated from reactive refetching. If refetching is not driven by URL, filter, paging, or explicit user action, keep it mount-only and do not tie it to unstable callback references.


## Data Fetching

API calls are made in root (View) components and passed to children via props.

```tsx
// ✅ CORRECT - Fetch at root, pass to children
const OrderDetailView = () => {
  const { data: order, isLoading, error } = useGetOrder(orderId)
  const { data: items } = useListOrderItems(orderId)

  if (isLoading) return <Skeleton />
  if (error) return <ErrorDisplay error={error} />

  return (
    <OrderSummary
      order={order}
      items={items}
      onItemSelect={handleItemSelect}
    />
  )
}

// ❌ WRONG - Child fetches its own data
const OrderSummary = ({ orderId }) => {
  const { data: order } = useGetOrder(orderId)
  // ...
}
```

When UI state changes affect parameters (week switching, filters, etc.):

Manage state at View level and pass callbacks to components.

```tsx
// ✅ CORRECT - State managed at View level
const ScheduleView = () => {
  const [currentWeek, setCurrentWeek] = useState(startOfWeek(new Date()))
  const { data } = useListSchedules({
    from: format(currentWeek, 'yyyy-MM-dd'),
    to: format(endOfWeek(currentWeek), 'yyyy-MM-dd'),
  })

  return (
    <WeeklyCalendar
      schedules={data?.items ?? []}
      currentWeek={currentWeek}
      onWeekChange={setCurrentWeek}
    />
  )
}

// ❌ WRONG - Component manages state + data fetching
const WeeklyCalendar = ({ facilityId }) => {
  const [currentWeek, setCurrentWeek] = useState(...)
  const { data } = useListSchedules({ facilityId, from, to })
  // ...
}
```

Exceptions (component-level fetching allowed):

| Case | Reason |
|------|--------|
| Infinite scroll | Depends on scroll position (internal UI state) |
| Search autocomplete | Real-time search based on input value |
| Independent widget | Notification badge, weather, etc. Completely unrelated to parent data |
| Real-time updates | WebSocket/Polling auto-updates |
| Modal detail fetch | Fetch additional data only when opened |

Widget conditions (must satisfy all):
- Completely unrelated to parent data
- Does not affect parent state
- Works the same on any page

If any condition is not met, fetch data at View level and pass via props.


### Screen-Specific API Usage

Fetch data from screen-specific API endpoints. Do not assemble screens by repurposing generic APIs. If an API doesn't exist, add a backend endpoint first rather than working around it on the frontend.


```tsx
// Avoid: Reusing list API for detail screen
const DetailScreen = ({ itemId }) => {
  const { data: list } = useListItems({ date })
  const item = list?.items.find(i => i.id === itemId)
  return <Detail item={item} />
}

// Example: Detail screen uses detail API
const DetailScreen = ({ itemId }) => {
  const { data: item } = useGetItem(itemId)
  return <Detail item={item} />
}
```

### Communication Scope Limitation

Communication is scoped to the active tab/screen. Do not prefetch for other tabs. Periodic polling runs only on the visible screen.


## Shared Components and Abstraction

Common UI patterns should be shared components. Copy-paste of inline styles is prohibited. UI that represents the same role or semantic state (placeholder, disabled, unconfirmed, etc.) must align copy, styling, and screen-reader output within the same shared component or an explicit design contract; presentation may vary with display context (hierarchy, density, theme), but the meaning and interaction contract must hold.

```tsx
// ❌ WRONG - Copy-pasted inline styles
<button className="p-2 text-[var(--text-secondary)] hover:...">
  <X className="w-5 h-5" />
</button>

// ✅ CORRECT - Use shared component
<IconButton onClick={onClose} aria-label="Close">
  <X className="w-5 h-5" />
</IconButton>
```

Patterns to make shared components:
- Icon buttons (close, edit, delete, etc.)
- Loading/error displays
- Status badges
- Tab switching
- Label + value display (detail screens)
- Search input
- Color legends

Avoid over-generalization:

```tsx
// ❌ WRONG - Forcing stepper variant into IconButton
export const iconButtonVariants = cva('...', {
  variants: {
    variant: {
      default: '...',
      outlined: '...',  // ← Stepper-specific, not used elsewhere
    },
    size: {
      medium: 'p-2',
      stepper: 'w-8 h-8',  // ← Only used with outlined
    },
  },
})

// ✅ CORRECT - Purpose-specific component
export function StepperButton(props) {
  return (
    <button className="w-8 h-8 rounded-full border ..." {...props}>
      <Plus className="w-4 h-4" />
    </button>
  )
}
```

Signs to make separate components:
- Implicit constraints like "this variant is always with this size"
- Added variant is clearly different from original component's purpose
- Props specification becomes complex on the usage side

### Theme Differences and Design Tokens

When you need different visuals with the same functional components, manage it with design tokens + theme scope.

Principles:
- Define color, spacing, radius, shadow, and typography as tokens (CSS variables)
- Apply role/page-specific differences by overriding tokens in a theme scope (e.g. `.consumer-theme`, `.admin-theme`)
- Do not hardcode hex colors (`#xxxxxx`) in feature components
- Keep logic differences (API/state) separate from visual differences (tokens)

```css
/* tokens.css */
:root {
  --color-bg-page: #f3f4f6;
  --color-surface: #ffffff;
  --color-text-primary: #1f2937;
  --color-border: #d1d5db;
  --color-accent: #2563eb;
}

.consumer-theme {
  --color-bg-page: #f7f8fa;
  --color-accent: #4daca1;
}
```

```tsx
// same component, different look by scope
<div className="consumer-theme">
  <Button variant="primary">Submit</Button>
</div>
```

Operational rules:
- Implement shared UI primitives (Button/Card/Input/Tabs) using tokens only
- In feature views, use theme-common utility classes (e.g. `surface`, `title`, `chip`) to avoid duplicated styling logic
- For a new theme, follow: "add tokens -> override by scope -> reuse existing components"

Review checklist:
- No copy-pasted hardcoded colors/spacings
- No duplicated components per theme for the same UI behavior
- No API/state-management changes made solely for visual adjustments

Anti-patterns:
- Creating `ButtonConsumer`, `ButtonAdmin` for styling only
- Hardcoding colors in each feature component
- Changing response shaping logic when only the theme changed

## Abstraction Level Evaluation

**Conditionals and abstraction:**

Express rendering branches in terms of user-visible states and responsibility. Once two implementations with the same meaning, contract, and reason to change are observed, decide the owner of a shared component or transformation. Do not require component splitting or polymorphism based only on branch count or syntax.

**Abstraction level mismatch detection:**

| Pattern | Problem | Fix |
|---------|---------|-----|
| Data fetching logic mixed in JSX | Hard to read | Extract to custom hook |
| Business logic mixed in component | Responsibility violation | Separate to hooks/utils |
| Style calculation logic scattered | Hard to maintain | Extract to utility function |
| Same transformation in multiple places | DRY violation | Extract to common function |

Good abstraction examples:

```tsx
// ❌ Conditional bloat
function UserBadge({ user }) {
  if (user.role === 'admin') {
    return <span className="bg-red-500">Admin</span>
  } else if (user.role === 'moderator') {
    return <span className="bg-yellow-500">Moderator</span>
  } else if (user.role === 'premium') {
    return <span className="bg-purple-500">Premium</span>
  } else {
    return <span className="bg-gray-500">User</span>
  }
}

// ✅ Abstracted with Map
const ROLE_CONFIG = {
  admin: { label: 'Admin', className: 'bg-red-500' },
  moderator: { label: 'Moderator', className: 'bg-yellow-500' },
  premium: { label: 'Premium', className: 'bg-purple-500' },
  default: { label: 'User', className: 'bg-gray-500' },
}

function UserBadge({ user }) {
  const config = ROLE_CONFIG[user.role] ?? ROLE_CONFIG.default
  return <span className={config.className}>{config.label}</span>
}
```

```tsx
// ❌ Mixed abstraction levels
function OrderList() {
  const [orders, setOrders] = useState([])
  useEffect(() => {
    fetch('/api/orders')
      .then(res => res.json())
      .then(data => setOrders(data))
  }, [])

  return orders.map(order => (
    <div>{order.total.toLocaleString()} USD</div>
  ))
}

// ✅ Aligned abstraction levels
function OrderList() {
  const { data: orders } = useOrders()  // Hide data fetching

  return orders.map(order => (
    <OrderItem key={order.id} order={order} />
  ))
}
```

## Frontend and Backend Separation of Concerns

### Display Format Responsibility

Backend returns "data", frontend converts to "display format".

```tsx
// ✅ Frontend: Convert to display format
export function formatPrice(amount: number): string {
  return `$${amount.toLocaleString()}`
}

export function formatDate(date: Date): string {
  return format(date, 'MMM d, yyyy')
}
```


### Domain Logic Placement (Smart UI Elimination)

Domain logic (business rules) belongs in the backend. Frontend only displays and edits state.

What is domain logic:
- Aggregate business rules (stock validation, price calculation, status transitions)
- Business constraint validation
- Invariant enforcement

Frontend responsibilities:
- Display state received from server
- Collect user input and send commands to backend
- Manage UI-only temporary state (focus, hover, modal open/close)
- Display format conversion (formatting, sorting, filtering)


Good and contrasting examples:

```tsx
// Avoid: Business rules in frontend
function OrderForm({ order }: { order: Order }) {
  const totalPrice = order.items.reduce((sum, item) =>
    sum + item.price * item.quantity, 0
  )
  const canCheckout = totalPrice >= 100 && order.items.every(i => i.stock > 0)

  return <button disabled={!canCheckout}>Checkout</button>
}

// ✅ GOOD - Display state received from server
function OrderForm({ order }: { order: Order }) {
  // totalPrice, canCheckout are received from server
  return (
    <>
      <div>{formatPrice(order.totalPrice)}</div>
      <button disabled={!order.canCheckout}>Checkout</button>
    </>
  )
}
```

```tsx
// Avoid: Status transition logic in frontend
function TaskCard({ task }: { task: Task }) {
  const canStart = task.status === 'pending' && task.assignee !== null
  const canComplete = task.status === 'in_progress' && /* complex conditions... */

  return (
    <>
      <button onClick={startTask} disabled={!canStart}>Start</button>
      <button onClick={completeTask} disabled={!canComplete}>Complete</button>
    </>
  )
}

// ✅ GOOD - Server returns allowed actions
function TaskCard({ task }: { task: Task }) {
  // task.allowedActions = ['start', 'cancel'], etc., calculated by server
  const canStart = task.allowedActions.includes('start')
  const canComplete = task.allowedActions.includes('complete')

  return (
    <>
      <button onClick={startTask} disabled={!canStart}>Start</button>
      <button onClick={completeTask} disabled={!canComplete}>Complete</button>
    </>
  )
}
```

Exceptions (OK to have logic in frontend):

| Case | Reason |
|------|--------|
| UI-only validation | UX feedback like "required field", "max length" (must also validate on server) |
| Client-side filter/sort | Changing display order of lists received from server |
| Display condition branching | UI control like "show details if logged in" |
| Real-time feedback | Preview display during input |

Decision criteria: "Would the business break if this calculation differs from the server?"
- YES → Place in backend (domain logic)
- NO → keep the logic in the frontend (display logic)

## Performance


Optimization Checklist:
- Are `React.memo` / `useMemo` / `useCallback` appropriate?
- Are large lists using virtual scroll?
- Is Code Splitting appropriate?
- Are images lazy loaded?

Anti-patterns:

```tsx
// ❌ New object every render
<Child style={{ color: 'red' }} />

// ✅ Constant or useMemo
const style = useMemo(() => ({ color: 'red' }), []);
<Child style={style} />
```

## Accessibility


Checklist:
- Using semantic HTML?
- Are ARIA attributes appropriate (not excessive)?
- Is keyboard navigation possible?
- Does it make sense with a screen reader?
- Is color contrast sufficient?

## TypeScript/Type Safety


## Frontend Security


## Testability
