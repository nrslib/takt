# GUI Knowledge

The screen (page on the Web) is the Root Mediator; a region component with independent state is a child Mediator. Display parts are Passive Views. Separate display, operation notification, and handling. Match ownership of state and operation decisions to scope and lifetime; avoid unnecessary custom layers for state, subscriptions, and operation handling.

Screen and region Mediators include their framework's standard state holders for that screen or region (such as a screen ViewModel, reference-type state owner, or Angular component-scoped service) and screen-specific Hook implementation splits.

Permitted arrangements are framework-standard state holders for a screen or region, screen-specific Hook implementation splits, use of adopted state management or data-fetching infrastructure, or arrangements based on sharing or lifetime requirements that need an independent state owner. Persisting across screen re-renders or use by several parts within one screen alone does not justify introducing a custom state owner.

Do not introduce a custom layer outside the permitted arrangements that takes over screen state and operation decisions, leaving the screen to delegate and render. Names or connection through a standard subscription API alone do not make an arrangement standard. A Hook that only delegates to another custom state owner is not a screen-specific implementation split.

## A hierarchy that starts at Root

Root is the screen itself (page on the Web). As the top-level Mediator, it owns state, accepts or rejects operations, decides the next state, and passes values and operation notification destinations to children. The screen combines regions and display parts. When a region within the screen has independent state and operations, that region's component manages them as a child Mediator. A Passive View display part notifies its responsible screen or region of operation intent, and the parent handles state shared by several regions and coordination between regions.

Keep state in the screen or region whose use range and lifetime match the value.

## The role of Passive View

A Passive View display part renders displayed content and operation availability passed down from its screen or region, and reports the user's operation intent to that responsible screen or region. Keep the decision to accept or reject an operation, and the following communication, navigation, and next-state decisions, in the screen or region that handles them instead of in the display part.

Keep an in-progress input value or open/closed state in the part that uses it. Share an identifier for the target or the progress of processing in the screen or region that coordinates the parts. Use Providers and external stores within the permitted arrangements according to scope and lifetime. This includes a screen creating values and operations and distributing them to several parts within that screen through a Provider. Keep screen-local editing state, such as form state, in the screen by default; let the adopted data-fetching infrastructure manage server-data fetching state and caches.

## Pass unhandled operations with Chain of Responsibility

Pass an operation to the next parent when the current part does not handle it. Each level handles only the operations it owns, and a handled operation is not run again at another level.

## Screen and region components process according to state as Mediators

Screen and region components own state as Mediators. They receive operation notifications and examine the current state and target to decide whether to accept or reject the operation, when to start the processing an accepted operation needs, the next state, and the display. The same decision determines displayed content, operation availability, and consistency between displayed and processed targets. Prevent re-running an operation while it is already processing when the operation cannot run concurrently.

Pure functions that return a new value or boolean from their arguments can live in separate files. Examples include validation, adding or combining list entries, change detection, price calculation, and reducer functions. Extracting logic into a screen-specific custom Hook that directly handles that screen's types, APIs, and state and keeps its decisions together is also an implementation split of the screen. It does not introduce a separate Mediator layer. API functions that only perform communication can also be separate.

Do not rely only on disabling a control or showing a modal: notifications from different entries such as clicks and keyboard input go through the same Mediator state decision. Start processing only for an accepted operation, and give the user feedback for a rejected operation without starting its processing. Reflect success, failure, invalid input, and insufficient permission in state and update the display. Pass only unhandled operations upward.

Before confirmation is answered, the operation handler rejects operations that change the target, input, saving state, or another premise of the decision. Allow an independent operation to continue when the specification permits it and it does not affect the pending decision. Apply the same distinction while processing: stop the same or conflicting operation, while allowing independent operations that remain safe.

Screen and region components, as Mediators, determine the next state from the current state and operation. This does not require dedicated state-machine machinery. Frameworks can realize the role with useReducer inside the screen and standard mechanisms such as props, callbacks, bindings, hooks, Context, and form actions. An ancestor-provided callback or Context operation can notify the responsible screen or region directly. Verify that the responsible side accepts or rejects the operation according to the current state and decides the state and display after processing.

## Reference

- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
