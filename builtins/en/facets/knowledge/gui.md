# GUI Knowledge

Build screens and parts in a hierarchy that starts at Root, and separate display, operation notification, and operation handling.

## A hierarchy that starts at Root

Root assembles the screen, and the screen combines regions and display parts. When a screen has independent operation regions, each region's Mediator manages the state and operations that complete within that region. A display part notifies its responsible region of operation intent, and the parent handles state shared by several regions and coordination between regions.

Keep state in the screen or region whose use range and lifetime match the value.

## The role of Passive View

A Passive View display part renders displayed content and operation availability passed down from its screen or region, and reports the user's operation intent to that responsible screen or region. Keep the decision to accept or reject an operation, and the following communication, navigation, and next-state decisions, in the screen or region that handles them instead of in the display part.

Keep an in-progress input value or open/closed state in the part that uses it. Share an identifier for the target or the progress of processing in the screen or region that coordinates the parts. Keep a value that survives several screens in a shared manager whose scope and lifetime match its use.

## Pass unhandled operations with Chain of Responsibility

Pass an operation to the next parent when the current part does not handle it. Each level handles only the operations it owns, and a handled operation is not run again at another level.

## Process according to state with Mediator

Mediator receives an operation notification and examines the current state and target to decide whether to accept or reject the operation, what processing an accepted operation needs, the next state, and the display. The same decision determines displayed content, operation availability, and consistency between displayed and processed targets. Prevent re-running an operation while it is already processing when the operation cannot run concurrently.

Do not rely only on disabling a control or showing a modal: notifications from different entries such as clicks and keyboard input go through the same Mediator state decision. Start processing only for an accepted operation, and give the user feedback for a rejected operation without starting its processing. Reflect success, failure, invalid input, and insufficient permission in state and update the display. Pass only unhandled operations upward.

Before confirmation is answered, the operation handler rejects operations that change the target, input, saving state, or another premise of the decision. Allow an independent operation to continue when the specification permits it and it does not affect the pending decision. Apply the same distinction while processing: stop the same or conflicting operation, while allowing independent operations that remain safe.

Mediator behaves as a state machine that determines the next state from the current state and operation. Frameworks can realize the role with standard mechanisms such as props, callbacks, bindings, hooks, Context, and form actions. An ancestor-provided callback or Context operation can notify the responsible screen or region directly. Verify that the responsible side accepts or rejects the operation according to the current state and decides the state and display after processing.

## Reference

- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
