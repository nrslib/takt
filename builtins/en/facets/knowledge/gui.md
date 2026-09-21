# GUI Knowledge

Understand a GUI through a hierarchy rooted at Root, state scope and lifetime, separation of display from behavior, operation-intent notification, and decisions based on current state.

## Hierarchy rooted at Root

Components belonging to a screen form a UI subtree that can be followed from Root. This hierarchy is the logical containment of components that own responsibilities and state; it is separate from DOM placement. Root composes the screen and is not a place where every state or side effect belongs. Choose the depth and number of intermediate components from responsibilities and reasons to change.

```
Root
└── screen or region behavior mediator
    ├── display component
    └── display component
```

The diagram expresses responsibility relationships. File placement and hierarchy depth follow responsibilities and reasons to change. A small screen may place Root and its behavior mediator in one component, while an independent region may have its own mediator. Make it possible to follow each display component to its subtree and identify who arbitrates its state and operations.

| Condition | Meaning or option |
|-----------|-------------------|
| The UI is reachable from Root and each subtree's responsibility is readable | The hierarchy shows change paths |
| Several display components must handle one fact consistently | Place the owner in the smallest subtree containing them |
| A region has independent placement, state, and communication | Close those responsibilities in the region's owner |
| Root composes the screen and delegates state to the required subtrees | Composition and state ownership are separated |

## State scope and lifetime

Keep state in the smallest subtree that must keep the fact consistent. Choose placement from usage scope and lifetime.

| State nature | Placement consideration |
|--------------|------------------------|
| Hover, focus, in-progress input, and open/close state confined to one component | The component or small subtree |
| Selection shared by nearby list and detail branches | The smallest owner containing both, then pass it to each View |
| Screen-level submitting, completed, and failed transitions | The screen or region behavior mediator |
| Sessions or settings that live across screens | A shared mechanism near Root with matching scope and lifetime |
| Fetched data and loading/error state | The subtree owner responsible for fetching and updating it |

### One owner for shared selection

When a list and detail view show the same selection, one smallest common owner keeps the selected ID. Passing the same operation path from list interaction to detail display makes the changed code and affected views traceable.

## Separation of display and behavior

Strict MVP Passive View receives the parameters needed to render and reports the user's operation intent. It does not arbitrate state transitions, communication, shared-state changes, or external side effects as a display component's own decisions.

A Mediator receives screen or region state and operation intent, decides whether the current state accepts it, and determines the next state and required side effects. The role may be implemented by a function, hook, reducer, or another framework-native unit; the responsibility must remain separate from display code.

```tsx
// Bad: the display component arbitrates communication and navigation
function SaveButton({ orderId }: { orderId: string }) {
  return (
    <button type="button" onClick={async () => {
      await fetch(`/orders/${orderId}`, { method: 'POST' })
      window.location.assign('/orders')
    }}>
      Save
    </button>
  )
}

// Good: the display component handles render parameters and intent notification
function SaveButton({ disabled, onSave }: {
  disabled: boolean
  onSave: () => void
}) {
  return <button type="button" disabled={disabled} onClick={onSave}>Save</button>
}
```

A small screen may keep Root and Mediator logic in one function when the code still distinguishes display inputs and outputs from the current-state operation decision. Framework-native state and input mechanisms fit when that boundary remains readable.

## Operation intent and event paths

Component callbacks, a Chain of Responsibility, and a Mediator are separate concepts. Make the path that delegates intent to an upper-level owner, and the condition that passes an unhandled intent to the next owner, traceable from the logical component hierarchy.

| Path | Role |
|------|------|
| Callback or binding | A child directly reports intent through an exposed operation entry |
| Chain of Responsibility | A handler decides whether it can handle intent and passes unhandled intent to the next handler |
| Mediator | Current state and intent determine acceptance, rejection, transition, and required side effects |

Design the delegation path and the rule that prevents an ancestor from processing an already-handled intent again.

## Decisions from current state

A state machine makes states, intents, transitions, and transition side effects explicit. When accepted operations differ by state, the screen or region Mediator makes the decision from current state instead of scattering conditions across display components.

The example shows state transitions and rendering parameters. The responsible handler executes communication for an accepted operation and passes its result back as the next intent.

```ts
type Phase = 'editing' | 'submitting' | 'success' | 'failure'
type ScreenState = { phase: Phase; message: string | null }
type Intent =
  | { type: 'submit' }
  | { type: 'retry' }
  | { type: 'completed' }
  | { type: 'failed'; message: string }

function transition(state: ScreenState, intent: Intent): ScreenState {
  if (intent.type === 'submit' && state.phase === 'editing') {
    return { phase: 'submitting', message: null }
  }
  if (intent.type === 'submit') {
    return state
  }
  if (intent.type === 'retry' && state.phase === 'failure') {
    return { phase: 'submitting', message: null }
  }
  if (intent.type === 'completed' && state.phase === 'submitting') {
    return { phase: 'success', message: 'Saved' }
  }
  if (intent.type === 'failed' && state.phase === 'submitting') {
    return { phase: 'failure', message: intent.message }
  }
  return state
}

function viewParameters(state: ScreenState) {
  return {
    submitDisabled: state.phase !== 'editing',
    retryVisible: state.phase === 'failure',
    message: state.message,
  }
}
```

The second submit during `submitting` is rejected by retaining the same state. Only `completed` or `failed` changes the display parameters. Acceptance and display reflection therefore come from one state model.

| Observable structure | Meaning or option |
|----------------------|-------------------|
| A display component receives render parameters and reports intent through an operation entry | Passive View responsibility is preserved |
| A screen or region owner reads current state and decides acceptance, rejection, and transition | Mediator arbitration is traceable |
| Root leads to display components and state owners | Hierarchy and ownership are readable |
| Intermediate components delegate intent without changing its meaning | Depth alone is not a structural problem |
| A display component individually decides communication, transition, or shared-state changes | Review the display/behavior boundary |
| The same intent runs through multiple operation paths | Review the operation entry and delegation chain |

## Reference

- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
