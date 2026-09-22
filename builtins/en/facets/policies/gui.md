# GUI Policy

Review how the screen is assembled, where state is kept, how display parts pass operations to their handler, and how the current state determines the result.

## Criteria

| Criterion | Decision |
|------|------|
| The screen and its parts can be followed from Root, and it is clear which screen or region handles each operation and manages its related state | OK |
| Several parts keep separate identifiers for the same target, so their display or operation target diverges | REJECT |
| A part owns an input value or open/closed state used only inside that part | OK |
| A display part renders values and reports operation intent upward | OK |
| A display part calls a screen-specific API and chooses navigation or the result after processing | REJECT |
| Mediator checks the current state and target and decides acceptance or rejection, processing, the next state, and the displayed result | OK |
| The operation path executes an operation that must be rejected without checking the state that determines whether it is allowed | REJECT |
| The result of an accepted operation is not reflected in the next state or displayed result | REJECT |
| Only an operation the current part does not handle is passed upward in order | OK |
| An ancestor runs an operation again after it was handled or rejected | REJECT |
| Before confirmation is answered, an operation changes the target, input, or saving state on which the decision depends | REJECT |
| While confirmation is pending, confirmation and cancellation are accepted and their results are reflected in state | OK |
| An independent operation that the specification permits or requires, and that does not affect the pending subject, is stopped unconditionally while confirmation is pending | REJECT |
| Click, keyboard, form, or other entries bypass the same state decision and can submit the same or a conflicting operation while processing | REJECT |
| Duplicate execution of the same operation or a conflicting operation is stopped while processing, while independent operations are allowed when the specification permits them | OK |

## Example

```text
NG: A shared display part calls a specific API when an operation occurs
    and chooses the URL after processing
    -> Every screen using the part must accept that communication and navigation

OK: Each independent operation region manages its own input and processing state to decide its operations.
    A display part reports intent to that region, and an operation that opens a shared help screen reports to the parent.

NG: While confirmation of discarding input is pending, another entry starts saving that input.
    -> The unsaved content that was the basis for confirmation changes.

OK: Mediator sees the pending confirmation state, rejects the save, and waits for the answer.
```
