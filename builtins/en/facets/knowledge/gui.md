# GUI Knowledge

Build screens and parts in a hierarchy that starts at Root, and separate display, operation notification, and operation handling.

## A hierarchy that starts at Root

Root assembles the screen, and the screen combines several display parts. Following the hierarchy shows where values enter a display part and where operations are reported.

Keep state in the screen or region whose use range and lifetime match the value.

## The role of Passive View

A Passive View display part renders values received from above and reports the user's operation intent upward. Keep communication, navigation, and state decisions in the screen or region that handles them instead of in the display part.

Keep an in-progress input value or open/closed state in the part that uses it. Share an identifier for the target or the progress of processing in the screen or region that coordinates the parts. Keep a value that survives several screens in a shared manager whose scope and lifetime match its use.

## Pass unhandled operations with Chain of Responsibility

Pass an operation to the next parent when the current part does not handle it. Each level handles only the operations it owns, and a handled operation is not run again at another level.

## Process according to state with Mediator

Mediator receives an operation notification and examines the current state and target to decide whether to accept or reject the operation, what processing an accepted operation needs, the next state, and the values to display as its result. Prevent re-running an operation while it is already processing when the operation cannot run concurrently.

Do not rely only on an enabled or disabled control: notifications from different entries such as clicks and keyboard input go through the same Mediator state decision. Reflect success, failure, invalid input, and insufficient permission in state and update the display. Show a rejected operation at the point of rejection, and pass only unhandled operations upward.

Mediator behaves as a state machine that determines the next state from the current state and operation. Frameworks realize the roles of Passive View, Chain of Responsibility, and Mediator with standard mechanisms such as props, callbacks, bindings, hooks, and reducers. A descendant can notify the responsible screen or region directly through a callback or Context operation provided by an ancestor.

## Reference

- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
