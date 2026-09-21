# GUI Knowledge

Build components in a hierarchy that starts at Root, and separate display work from interaction handling.

## A hierarchy that starts at Root

Root builds the screen, and the screen combines parts such as a list and a detail view.

```
Root
└── Order screen
    ├── Order list
    └── Order detail
```

Following this hierarchy shows which screen displays a part and where an operation is handled. Use Root to assemble the screen, and keep state close to the screen or part that uses it.

## Where to keep state

When the list and detail view select the same order, keep one `selectedId` in their common parent and pass it to both. Keep an in-progress input value or open/closed state in the part that uses it.

If both the list and detail view show the save state, keep one `saveState` in the screen. Keep long-lived values such as login information in a shared part that contains the screens that use them. Choose the location from the parts that read the same value and how long the value must remain.

## Separate display from interaction

A display part renders values received from the screen and reports operations upward. A save button calls `onSave`. The screen checks whether a save is already in progress and starts communication only when saving is allowed. It updates state on success or failure and reflects that state in the button and message.

```
editing    --save--> submitting --success--> success
                                └--failure--> failure
submitting --save--> rejected
```

While `submitting`, disable the save button so the same save is not sent twice. Show completion on success and an error with retry on failure. The screen makes this decision; the display part renders the values it receives.

## Pass operations upward

Pass an operation upward when a part does not handle it. For example, pass a delete request from a row to the list and from the list to the screen; the screen checks its current state and deletes the item. An ancestor must not run an operation again after it has been handled or rejected.

## Mapping to established patterns

MVP Passive View describes a display part that receives values needed for drawing and reports operation intent. A mechanism that passes an operation to the next handler when the current handler cannot process it is called Chain of Responsibility. Mediator describes a screen or region deciding, from its current state, whether to accept an operation and what state and processing should follow. A state machine represents those states and transitions.

Frameworks realize this division with standard mechanisms such as props, callbacks, bindings, hooks, and reducers. For example, a descendant calls a callback provided by an ancestor to notify that ancestor directly of an operation.

## Reference

- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
