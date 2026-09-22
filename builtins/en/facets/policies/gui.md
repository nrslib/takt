# GUI Policy

Review how the screen is assembled, where state is kept, how display parts pass operations to their handler, and how the current state determines the result.

## Criteria

| Criterion | Decision |
|------|------|
| The screen and its parts can be followed from Root, and the place that handles each operation is clear | OK |
| Several parts keep separate identifiers for the same target, so their display or operation target diverges | REJECT |
| A part owns an input value or open/closed state used only inside that part | OK |
| A display part renders values and reports operation intent upward | OK |
| A display part calls a screen-specific API and chooses navigation or the result after processing | REJECT |
| Mediator checks the current state and target and accepts or rejects the operation | OK |
| Mediator coordinates the processing, state transition, and result display for an accepted operation | OK |
| Only an operation the current part does not handle is passed upward in order | OK |
| An ancestor runs an operation again after it was handled or rejected | REJECT |
| Click, keyboard, form, or other entries bypass the same state decision and can submit again while an operation is processing | REJECT |

## Example

```text
NG: A shared display part calls a specific API when an operation occurs
    and chooses the URL after processing
    -> Every screen using the part must accept that communication and navigation

OK: The screen or region passes display values to the display part and receives operation notifications.
    The display part renders the values and reports the operation intent
    -> Mediator checks current state and decides processing, navigation, and result display
```
