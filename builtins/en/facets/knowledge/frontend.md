{extends:gui}

# Frontend Knowledge

Apply GUI design to the web runtime: URLs, browser behavior, HTML, communication, accessibility, and browser safety. Separate the reasons for changing display, operations, state, and communication so the impact path remains traceable.

## URLs and screen navigation

A URL is an entry to a screen and state referenced by browser history and external links. A router maps the URL to the screen Root; the screen or routing owner handles path, query, and history contracts.

```text
route('/orders/:orderId', OrderScreen)
```

When adding a screen, trace the route-to-Root path, user-facing entries such as menus and links, and direct URL and back/forward behavior. Route placement and directories follow the framework and the reasons to change.

| Condition | Meaning or option |
|-----------|-------------------|
| A URL identifier or search condition is required by screen state | Pass it explicitly from the URL |
| A display state lives only within the screen | Keep it as screen state |
| Back/forward should restore an operation | Treat the operation as a history transition |
| Direct navigation finds no resource or insufficient permission | Distinguish screen error, empty state, and redirect |

Collect navigation decisions in the screen or routing owner. Display components report navigation intent so links, keyboard operations, and external links follow the same decision path.

## HTML operations and accessibility

HTML elements provide keyboard behavior, focus, form submission, and state exposure to assistive technology in addition to visual output. Match the element to the operation contract.

DOM events travel from ancestors to the target during capture and from the target to ancestors during bubble. This propagation path is separate from the application path that reports intent to an owner. Check default actions and operation entries so one operation is not executed through both paths.

```tsx
// Bad: a non-interactive element with only a click handler
<div onClick={openDialog}>Details</div>

// Good: use the native operation contract
<button type="button" onClick={openDialog}>Details</button>
```

Every new operation needs a purpose-revealing accessible name, an appropriate element or role, states such as disabled/expanded/selected, and keyboard access. Associate form labels with their controls. Include focus movement and restoration in the operation path when opening and closing dialogs.

Compose dynamic text so the final announcement has meaning. In a list with multiple edit or delete controls, make the target identifiable by its name or programmatic row/group association.

| UI state | Contract to check |
|----------|------------------|
| Selected, expanded, checked, or disabled | Element or attribute that exposes the state to assistive technology |
| Loading, success, or failure | A notification when needed and a recovery operation |
| Empty list | A display that distinguishes no data from failed retrieval |
| Dialog or menu | Opening operation, focus, closing operation, and focus restoration |

Check the installed UI library version against its implementation, types, and official documentation for supported props and element structure. With wrappers or attribute overrides, verify the actual rendered name, role, state, and interaction. Passing shallow mocks does not verify real library rendering or behavior.

## Communication states and display

A communicating screen distinguishes not started, loading, success, empty, failure, and cancelled states. Convert failures into screen states that give the user retry, correction, or another recovery operation.

```tsx
// Bad: a generic empty state contains a screen-specific communication procedure
function EmptyState() {
  async function retry() {
    await fetch('/orders')
    window.location.reload()
  }

  return <button type="button" onClick={retry}>Reload</button>
}

// Good: the generic display receives render parameters and intent notification
function EmptyState({
  title,
  description,
  onRetry,
}: {
  title: string
  description: string
  onRetry?: () => void
}) {
  return (
    <section aria-live="polite">
      <h2>{title}</h2>
      <p>{description}</p>
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
    </section>
  )
}
```

The screen communication owner passes text and a retry entry to `EmptyState`, so changing the communication method does not change the generic display. Embedding a URL, API client, or navigation procedure in the generic display expands the change scope for every reuse.

## Data-fetching boundary

The screen or region owner that needs the data handles its retrieval and updates. A screen-wide owner, an independent region, or a data library can own this work when the data scope and operation path are explicit.

A display-only component receives display values and operation entries. It does not build fetch conditions or arbitrate communication errors.

```tsx
// Bad: a generically named display component mixes screen-specific fetching and display decisions
function DataTable({ accountId }: { accountId: string }) {
  const result = ordersForAccount(accountId)
  if (result.status === 'loading') return <Loading />
  if (result.status === 'error') return <ErrorPanel onRetry={result.retry} />
  if (result.orders.length === 0) {
    return <EmptyState title="No orders" description="Create a new order" />
  }
  return <Table rows={result.orders} onRowSelect={result.select} />
}

// Good: the screen owner decides communication states and passes values and intent entries
function OrderScreen({ result }: { result: OrderScreenResult }) {
  if (result.status === 'loading') return <Loading />
  if (result.status === 'error') return <ErrorPanel onRetry={result.retry} />
  if (result.orders.length === 0) {
    return <EmptyState title="No orders" description="Create a new order" />
  }
  return <OrderTable rows={result.orders} onSelect={result.select} />
}

function OrderTable({ rows, onSelect }: { rows: Order[]; onSelect: (id: string) => void }) {
  return <Table rows={rows} onRowSelect={onSelect} />
}
```

When `DataTable` embeds an orders API, order-specific empty text, and order-screen retry behavior, its generic name hides screen coupling. Keep communication-state decisions in the screen owner so the display component can focus on rows and selection notification. Choose an API client, handwritten fetch, or query library according to the existing communication boundary and contract.

When a generated API client handles the API in use, reuse its types, authentication, and error conversion. Reimplementing the same API communication separately can leave one path behind when schemas or authentication change.

## Cache and pagination

Choose a cache from the conditions that identify the same data, the way stale data is discarded after updates, and page continuity. Include URL, user, tenant, filter, sort, page, cursor, and every other condition that changes the result in the cache key or dependency.

```tsx
// Bad: accountId is missing, so accounts with the same filter share results
const key = ['orders', { filter, page }]

// Good: every result condition is present in one key
const key = ['orders', { accountId, filter, page }]
```

Cursor and offset names do not decide cache suitability. Check insertion, deletion, reordering, stale cursors, duplicate or missing pages, and post-update refetch against the server and library contract. A screen snapshot without a cache is also valid when its update behavior is explicit.

## Frontend and server responsibilities

Keep server-authoritative business state separate from display and input state known only by the browser. Client-side validation during input, sorting, filtering, and preview are screen responsibilities when the server remains the final authority.

| Decision | Primary owner |
|----------|---------------|
| Inventory, price, permission, and business state transitions | Server result is authoritative; UI renders the result and permitted operations |
| Required fields, length, and input-format feedback | Browser gives immediate feedback; server validates required constraints too |
| Ordering, display filters, and preview of received data | UI display state |
| Currency, date, and unit formatting | User locale and display context; keep it separate from values sent or stored |

Client display calculations belong to the screen state. The final business state changes through the server operation and its result.

## Browser safety

Trace browser input and execution boundaries. Check escaping for user input inserted into HTML or URLs, the source and sanitization boundary for direct HTML, external destinations, Cookie and Web Storage handling, CSRF-required requests, and cross-origin boundaries against the implementation and server contract.

```tsx
// Bad: interpret user input as HTML
return <div dangerouslySetInnerHTML={{ __html: comment }} />

// Good: render it as text; make an approved source and sanitization boundary explicit when HTML is required
return <div>{comment}</div>
```

Deep authentication, authorization, cryptography, and server-side validation decisions belong to security expertise. Frontend review follows values entering and leaving the browser and the operations that carry them.

## Changeable component boundaries

Choose component boundaries from responsibility, reason to change, reuse unit, and state ownership. Hiding a screen-specific API or route in a display component makes visual changes affect communication procedures.

| Condition | Meaning or option |
|-----------|-------------------|
| Several screens share a display while retrieval differs per screen | Display receives values and operation entries; retrieval stays with the screen |
| A component manages only input or open/close state and has no external effect | Keep the state within that component |
| Several branches read and write one fact | Place state and operations in a common owner |
| Screen-specific conditions accumulate in a generic component | Separate screen behavior from display reasons to change |
| Props are delegated without changing their meaning | Use ownership and change impact rather than depth to assess the split |

Names such as container or presentational can explain a responsibility. Establish the boundary from change reasons and operation paths.
