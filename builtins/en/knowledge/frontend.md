# Frontend Knowledge

## Component Design

Do not write everything in one file. Always split components.

Required splits:
- Has its own state → Must split
- JSX over 50 lines → Split
- Reusable → Split
- Multiple responsibilities → Split
- Independent section within page → Split

| Criteria | Judgment |
|----------|----------|
| Component over 200 lines | Consider splitting |
| Component over 300 lines | REJECT |
| Display and logic mixed | Consider separation |
| Props drilling (3+ levels) | Consider state management |
| Component with multiple responsibilities | REJECT |

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

## State Management

Child components do not modify their own state. They bubble events to parent, and parent manipulates state.

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

| Criteria | Judgment |
|----------|----------|
| Unnecessary global state | Consider localizing |
| Same state managed in multiple places | Needs normalization |
| State changes from child to parent (reverse data flow) | REJECT |
| API response stored as-is in state | Consider normalization |
| Inappropriate useEffect dependencies | REJECT |

State Placement Guidelines:

| State Nature | Recommended Placement |
|--------------|----------------------|
| Temporary UI state (modal open/close, etc.) | Local (useState) |
| Form input values | Local or form library |
| Shared across multiple components | Context or state management library |
| Server data cache | Data fetching library (TanStack Query, etc.) |

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

Decision criteria: "Is there no point in parent managing this / Does it not affect parent?"

| Criteria | Judgment |
|----------|----------|
| Direct fetch in component | Separate to Container layer |
| No error handling | REJECT |
| Loading state not handled | REJECT |
| No cancellation handling | Warning |
| N+1 query-like fetching | REJECT |

## Shared Components and Abstraction

Common UI patterns should be shared components. Copy-paste of inline styles is prohibited.

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

**Conditional branch bloat detection:**

| Pattern | Judgment |
|---------|----------|
| Same conditional in 3+ places | Extract to shared component → **REJECT** |
| Props-based branching with 5+ types | Consider component split |
| Nested ternaries in render | Early return or component separation → **REJECT** |
| Type-based render branching | Consider polymorphic components |

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

| Criteria | Judgment |
|----------|----------|
| Backend returns display strings | Suggest design review |
| Same format logic copy-pasted | Unify to utility function |
| Inline formatting in component | Extract to function |

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

| Criteria | Judgment |
|----------|----------|
| Price calculation/stock validation in frontend | Move to backend → **REJECT** |
| Status transition rules in frontend | Move to backend → **REJECT** |
| Business validation in frontend | Move to backend → **REJECT** |
| Recalculating server-computable values in frontend | Redundant → **REJECT** |

Good vs Bad Examples:

```tsx
// ❌ BAD - Business rules in frontend
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
// ❌ BAD - Status transition logic in frontend
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
- NO → OK in frontend (display logic)

## Performance

| Criteria | Judgment |
|----------|----------|
| Unnecessary re-renders | Needs optimization |
| Large lists without virtualization | Warning |
| Unoptimized images | Warning |
| Unused code in bundle | Check tree-shaking |
| Excessive memoization | Verify necessity |

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

| Criteria | Judgment |
|----------|----------|
| Interactive elements without keyboard support | REJECT |
| Images without alt attribute | REJECT |
| Form elements without labels | REJECT |
| Information conveyed by color only | REJECT |
| Missing focus management (modals, etc.) | REJECT |

Checklist:
- Using semantic HTML?
- Are ARIA attributes appropriate (not excessive)?
- Is keyboard navigation possible?
- Does it make sense with a screen reader?
- Is color contrast sufficient?

## TypeScript/Type Safety

| Criteria | Judgment |
|----------|----------|
| Use of `any` type | REJECT |
| Excessive type assertions (as) | Needs review |
| No Props type definition | REJECT |
| Inappropriate event handler types | Needs fix |

## Frontend Security

| Criteria | Judgment |
|----------|----------|
| dangerouslySetInnerHTML usage | Check XSS risk |
| Unsanitized user input | REJECT |
| Sensitive data stored in frontend | REJECT |
| CSRF token not used | Needs verification |

## Testability

| Criteria | Judgment |
|----------|----------|
| No data-testid, etc. | Warning |
| Structure difficult to test | Consider separation |
| Business logic embedded in UI | REJECT |

## Anti-pattern Detection

REJECT if found:

| Anti-pattern | Problem |
|--------------|---------|
| God Component | All features concentrated in one component |
| Prop Drilling | Deep props bucket brigade |
| Inline Styles abuse | Maintainability degradation |
| useEffect hell | Dependencies too complex |
| Premature Optimization | Unnecessary memoization |
| Magic Strings | Hardcoded strings |
| Hidden Dependencies | Child components with hidden API calls |
| Over-generalization | Components forced to be generic |
