# GUI Knowledge

Provide the foundational knowledge for understanding GUIs through hierarchy, state ownership, intent paths, and separation of display from behavior.

## UI Hierarchy

A screen is a subtree of the UI rooted at Root. Root is the structural boundary that contains the UI; it does not mean that every state or side effect must be concentrated in one component. A screen region or independent widget may have an owner for its own subtree.

Think about responsibilities through these conceptual roles:

| Role | Main responsibility |
|------|---------------------|
| Root | Starting point for the UI hierarchy and composition of screens or widgets |
| State owner | State, operations, and external side-effect decisions that must stay consistent in a subtree |
| Display View | Renders display values and reports user intent upward |

A small screen may combine these roles in one component. The purpose of the roles is to make the state owner and operation path traceable, not to require more classes or a particular file layout.

## State Ownership

Place state in the smallest subtree that needs the state to remain consistent. Temporary state confined to display can stay local to a display component; state shared by multiple branches belongs to their common owner. State shared across screens or concerns can be owned by Context, an external store, or another shared mechanism.

| State nature | Placement consideration |
|--------------|-------------------------|
| Hover, focus, in-progress input, or open/close state used only for display | The component or small subtree that uses it |
| State that must stay consistent across nearby components | The nearest common state owner |
| State shared across deep hierarchy or multiple screens | Context, a store, or another shared state mechanism |
| Server data and refetch state | A query, data-fetching hook, state owner, or another mechanism with an explicit consistency contract |

A child that directly writes a parent or shared state without using the owner's public update contract hides who arbitrates consistency. A parent-provided operation callback, Context dispatch, a store's public API, or form binding routes the update through an owner's contract even when the child initiates it, so it is not by itself a violation of ownership. A child may also keep local state for its own concern.

## Separation of Display and Behavior

Passive View is a basic model in which a view does not arbitrate state changes or external side effects: it receives display values, renders them, and reports user intent. A Mediator is the role that decides the next state or side effect from current state and user intent.

This model is also easy to explain without a framework. React hooks, reducers, Context Providers, query hooks, form controllers, Vue composables, and Angular services can realize the same responsibilities without being converted into MVP classes. The relevant questions are whether display and behavior are separated, who owns the state, and how the operation travels.

A display component may own a small local input state or use standard binding. The problem is hiding communication, shared-state mutation, or business arbitration behind a display convenience when another owner should decide it.

## Intent and Event Paths

Native event propagation is a separate layer from application-level intent notification. Distinguish the event path provided by the browser or framework from the path that delivers intent to a state owner.

| Path | Use |
|------|-----|
| Native event propagation | Input source, default actions, and integration with the external environment |
| Public callback | A child reports intent through an operation exposed by its parent |
| Context, dispatch, or store | Intent reaches a shared state owner inside the hierarchy |
| Query, form, or binding API | A framework or library provides the state and operation entry point |

Stop or duplicate behavior follows the actual operation contract and owner. An intermediate component that accepts a public callback and passes it upward without changing its meaning is not automatically a hidden bypass.

An intent is delegated along the hierarchy until it reaches the responsible state owner. Passing an unhandled intent upward is the basic Chain of Responsibility model. Once the responsible owner accepts or rejects the operation, an ancestor performing the same intent as a second operation creates unintended duplicate processing.

## State Machines

A state machine makes states, intents, transitions, and transition side effects explicit. It helps when the accepted intents differ by state, such as dialog open/close, submitting/completed, or available operations.

Reducer branches, hook state transitions, Context dispatch, store actions, and query loading/error/success states can all realize the same model when the relevant information remains traceable. A transition table, a dedicated library, the name Mediator, or a particular class structure is not itself evidence of quality.

## Design Signals

| Observable structure | Judgment |
|----------------------|----------|
| The UI is reachable from Root and each shared state and operation has an owner | The hierarchy is coherent |
| A display View renders values and reports intent through a public operation entry | Passive View responsibilities are separated |
| Hooks, Context, dispatch, query, form, or binding implement state and operations with a traceable owner | Framework-fit realization |
| A small screen keeps state and display together while its owner and paths are clear | Do not force a split |
| Props or callbacks pass through intermediaries without changing meaning and reach the responsible owner | Depth alone is not a defect |
| DOM events and application operations perform the same action twice | Investigate duplicate processing |
| A pattern or class name is absent | Not evidence of a defect |
