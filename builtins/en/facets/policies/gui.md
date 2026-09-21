# GUI Policy

Review how the screen is assembled, where state is kept, how display parts pass operations to the screen, and how the current state determines the result.

## Criteria

| Criterion | Decision |
|------|------|
| The screen and its parts can be followed from Root, and the place that handles each operation is clear | OK |
| The list and detail view keep separate `selectedId` values for the same order, so their displays diverge | REJECT |
| A part owns an input value or open/closed state used only inside that part | OK |
| A display part renders values and reports operations upward with `onSelect` or `onSave` | OK |
| A display part calls a screen-specific API and chooses where to navigate after saving | REJECT |
| The screen checks current state, accepts or rejects the operation, and updates state | OK |
| A delete request moves from row to list to screen, and the screen performs the deletion | OK |
| An ancestor runs an operation again after it was handled or rejected | REJECT |
| Only the save button checks whether saving is in progress, so keyboard input can submit again while saving | REJECT |

## Example

```text
NG: A shared ResultsTable calls the order API when a row is clicked
    and navigates to the order detail URL
    -> Every other screen using the table must accept the order API and destination

OK: The screen passes rows and onSelect(id) to the table
    The table renders rows and calls onSelect(id)
    -> The screen decides selection, communication, and destination
```
