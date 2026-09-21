# GUI Policy

Judge GUI structure, state ownership, display and behavior separation, operation-intent paths, and current-state arbitration by the change impact that can be traced.

## Principles

| Principle | Criterion |
|-----------|-----------|
| Hierarchy | Screen components are reachable from Root and each subtree's responsibility is readable |
| State scope | An owner exists in the smallest subtree that must keep the fact consistent |
| Passive View | A display component handles render parameters and reports intent; it does not arbitrate transitions, communication, or shared-state changes |
| Mediator | A screen or region owner decides acceptance, rejection, transitions, and side effects from current state and intent |
| Operation path | The route from intent to its owner is traceable and a handled intent is not executed twice |
| Changeability | Generic display components are not coupled to screen-specific communication or transitions, and change scope is readable |
| Structure | Ownerless state, mixed responsibilities, and hidden change paths are evidence alongside runtime defects |

## Hierarchy and state ownership

| Criterion | Judgment |
|-----------|----------|
| UI cannot be followed from Root and no display, state, or operation owner can be traced | REJECT |
| Multiple components keep one fact separately, so display or operation results depend on update order | REJECT |
| A child changes state in another subtree without its owner's operation entry | REJECT |
| State is placed in a subtree matching its scope and lifetime, with a readable path from owner to display | OK |
| Root composes the screen and delegates required state to subtrees | OK |

## Display and behavior

| Criterion | Judgment |
|-----------|----------|
| A display component individually performs navigation, communication, shared-state changes, or business acceptance decisions | REJECT |
| A display component receives render values and reports intent through the responsible operation entry | OK |
| A screen or region owner reads current state and decides acceptance, rejection, and transition | OK |
| A small screen keeps display and arbitration in one function while the two responsibilities and paths remain visible in code | Check the change reason |

Place framework-native components according to this responsibility boundary. Judge the mixed responsibility and change path.

## Operation intent and events

| Criterion | Judgment |
|-----------|----------|
| Intent bypasses its owner's operation entry and directly changes another state owner | REJECT |
| An intermediate component delegates intent without changing its meaning | OK |
| An ancestor executes the same save, deletion, or other operation again after its owner accepted or rejected it | REJECT |
| Callback, operation delegation, and Chain of Responsibility are treated as one mechanism so owner or stopping condition cannot be traced | REJECT |

## State transitions and change scope

| Criterion | Judgment |
|-----------|----------|
| Accepted operations differ by state, yet each display component makes its own state condition | REJECT |
| State, intent, transition, and resulting display are traceable to one owner | OK |
| Screen-specific communication or transition logic is added to a generic display component to preserve its apparent reuse | REJECT |
| Independent display, state, and external-side-effect reasons to change are mixed into one responsibility and the path cannot be traced | REJECT |
