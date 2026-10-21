# GUI Policy

Review how the screen is assembled, where state is kept, how display parts pass operations to their handler, and how the current state determines the result.

## Criteria

Permitted arrangements are framework-standard screen/region state holders, screen-specific Hook implementation splits, use of adopted state management/fetching infrastructure, or arrangements based on sharing/lifetime requirements that need an independent state owner. Persisting across screen re-renders or use by several parts within one screen alone does not justify a new custom state owner.

| Criterion | Decision |
|------|------|
| A new custom state-holding/operation-handling layer outside the permitted arrangements takes over screen state and operation decisions, leaving the screen to delegate and render | REJECT |
| Several parts keep separate identifiers for the same target, so their display or operation target diverges | REJECT |
| A display part calls a screen-specific API and chooses navigation or the result after processing | REJECT |
| The operation path executes an operation or its processing that must be rejected without checking the state that determines whether it is allowed | REJECT |
| The result of an accepted operation is not reflected in the next state or displayed result | REJECT |
| An ancestor runs an operation again after it was handled or rejected | REJECT |
| Before confirmation is answered, an operation changes the target, input, or saving state on which the decision depends | REJECT |
| An independent operation that the specification permits or requires, and that does not affect the pending subject, is stopped unconditionally while confirmation is pending | REJECT |
| Click, keyboard, form, or other entries bypass the same state decision and can submit the same or a conflicting operation while processing | REJECT |
| The Root screen (Web page) and independent regions act as Mediators using framework-standard state holders for that screen/region (ViewModels, reference-type state owners), screen-specific Hooks, or standard state/reducers; no dedicated state machine is required | OK |
| Pure functions/reducers handle validation, list additions/totals, change detection, and pricing; communication-only API functions are separate | OK |
| Within the permitted arrangements, Providers/stores fit scope and lifetime; adopted infrastructure owns fetch caches. A screen may create values/operations and distribute them within the screen via a Provider. Keep local editing state in the screen by default, distinct from server-data fetch caches | OK |
| A part owns an input value or open/closed state used only inside that part | OK |
| A display part renders values and reports operation intent upward | OK |
| A screen or region component, as Mediator, checks the current state and target and decides acceptance or rejection, processing start, the next state, displayed content, operation availability, and consistency between displayed and processed targets | OK |
| Only an operation the current part does not handle is passed upward in order | OK |
| While confirmation is pending, confirmation and cancellation are accepted and their results are reflected in state | OK |
| Duplicate execution of the same operation or a conflicting operation is stopped while processing, while independent operations are allowed when the specification permits them | OK |

Names do not matter. Standard subscription APIs or renaming alone do not make an arrangement standard. A Hook that only delegates to another custom state owner is not a screen-specific implementation split.

## Example

```text
NG: A shared display part calls a specific API when an operation occurs
    and chooses the URL after processing
    -> Every screen using the part must accept that communication and navigation

OK: The screen owns state and operation decisions as the Root Mediator, and each independent operation region's component manages its own input and processing state as a child Mediator to decide its operations.
    A display part reports intent to that region, and an operation that opens a shared help screen reports to the parent.

NG: While confirmation of discarding input is pending, another entry starts saving that input.
    -> The unsaved content that was the basis for confirmation changes.

OK: The screen or region component, as Mediator, sees the pending confirmation state, rejects the save, and waits for the answer.

NG: A custom state-holding object newly introduced outside the screen fits none of the permitted arrangements, yet owns screen state and operation decisions, leaving the screen to delegate and render.
    -> Return state and operation decisions to the screen Mediator implementation.

OK: The screen owns state and operation decisions and uses pure functions for calculations.
    It can also split implementation into a screen-specific Hook handling its types, APIs, and state.
```
