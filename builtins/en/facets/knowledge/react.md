# React Knowledge

In React, parents pass values through props, components keep changing values in state, and rendering creates the screen. Put screen communication and navigation in handlers or hooks rather than inside display components. React can provide the GUI Mediator role through standard mechanisms such as screen handlers, custom Hooks, Context, and reducers, which decide processing and the next state from an operation and the current state.

## Props and state

Props are inputs passed by a parent; state is a value a component changes through interaction. Do not keep the same fact in two `useState` calls. Keep it where its scope and lifetime fit. When several parts use the same target identifier or input, keep one value in the parent or screen that coordinates them and pass props and operation notifications. Keep an in-progress input value or open/closed state in the part that uses it. Keep a value that should survive several screens in a Provider or external store whose scope and lifetime fit.

## Prop changes and state lifetime

The initial value passed to `useState` is not copied into state again when props change. An input that continues to display the parent's value should receive the value and change handler as props. A draft that should not reach the parent until it is confirmed can stay in the component's state. When switching to another target, use its stable identifier as `key` to create a new instance, or reset state as part of the switch. Copying props into state in an Effect can overwrite a value that is being edited.

## Compute derived values

Do not store a list, count, all-selected result, label, or other value calculable from props or state as separate state. Calculate it from the same conditions during rendering to avoid an old display or a decision that depends on update order. If the amount of computation is an actual problem, reuse it with `useMemo` or a similar mechanism and state its dependencies.

## Context passes values

`createContext` creates a mechanism for descendants to read a value provided by an ancestor's Provider. A Provider can use `useState` or `useReducer` and pass state, dispatch, and handlers that start operations shared by several screen parts. `useContext` reads the value within its scope and lifetime; keep local values local.

## Mediator, reducers, and operations

A screen handler or custom Hook acts as the Mediator: it receives an operation notification, checks the current state and target, accepts or rejects the operation, and decides the processing needed for an accepted operation, the rejection result, the next state, and the displayed values. Form, button, keyboard, and other entries for the same operation go through the same Mediator decision. Do not use a control's `disabled` display as the only decision; also check state and target where processing starts.

A reducer is a pure function that returns the next state from the current state and an event. A handler starts communication outside the reducer and dispatches its start, success, and failure results. The reducer does not perform communication, timers, or notifications. Rejection, invalid input, insufficient permission, and conflicts become display results through this state flow.

React state updates are reflected in the next render; the state read by the same handler immediately after `dispatch` does not change within that handler. When another notification can arrive before that render, do not judge it with old state that omits the earlier acceptance and start communication or a timer for an operation that must be rejected. Keep the acceptance decision and side-effect start in the same control path, start only an accepted operation, and judge a later notification with state that reflects the earlier acceptance. Choose an implementation that fits the framework and conditions.

Form submission should notify the handler once through the chosen entry, such as `onSubmit`, a form `action`, or another standard mechanism, and go through the same state decision. Actions such as pressing Enter that submit the form should use that same state decision, and submission processing should not run more than once. Even when a Portal places a part elsewhere in the DOM, React events propagate through the React tree to its ancestors.

## Effects and external systems

`useEffect` synchronizes React with connections, subscriptions, timers, fetches, and other systems outside rendering. A submission or notification caused by one user operation belongs in an event handler or command, not in an Effect.

Include props, state, and variables or functions declared inside the component that the Effect reads in its dependency array. Dependencies must match the conditions that should cause reconnection or refetching; do not remove one only to silence a lint warning. If a callback reference actually causes unnecessary reruns, stabilize the handler, move it outside the Effect, or separate the synchronization targets.

Connections, subscriptions, timers, and fetches need cleanup before rerun and on unmount. When an identifier change should start a new fetch, include it in the dependencies and cancel the previous fetch in cleanup with `AbortController` or an equivalent. Do not turn an aborted result into a failure message, and prevent an old response from overwriting newer state.

## React execution rules

Call Hooks at the top level of a component or custom Hook, never inside a condition or loop. During rendering, do not communicate, notify, manipulate the DOM, change an external variable, or mutate props and state directly.

In a reorderable list, use the item's stable identifier as `key` instead of the array index. When a `key` changes, React treats the element as a different component and resets its state, so match component position and state lifetime to the intended behavior.

## Custom Hooks

A component responsible for a screen or region can use a custom Hook to group state, Effects, refs, Context, queries, forms, and event conversion as one screen behavior, then pass display values and operation notifications to display parts. Put pure calculations in a regular function. State created by `useState` inside a Hook is separate for each call to that Hook. A Hook that reads Context, a query, or an external store can return a value shared by its source, so determine sharing from what it reads and writes rather than its name.

## TanStack Query and cache

With TanStack Query's `useQuery`, pass conditions that change a result with the same meaning to `queryKey` and `queryFn`. Do not omit user, tenant, target identifier, filter, sort, page, cursor, or another condition from the key when it changes the result, or different results will share one cache entry.

After an update, replace stale results with invalidation, a refetch, or a TanStack Query cache update. In a paged list, ensure that cursor, sort, filter, and snapshot match the server result and that duplicates and gaps caused by intervening updates are handled.

## Props types and Hook placement

Keep a Props type used by one component near that component. Put a type used by several parts where it can be shared. A screen Hook can return the values and operations needed for display, and the component can render from them.

## References

- React: Thinking in React
  https://react.dev/learn/thinking-in-react
- React: Sharing State Between Components
  https://react.dev/learn/sharing-state-between-components
- React: Responding to Events
  https://react.dev/learn/responding-to-events
- React: Passing Data Deeply with Context
  https://react.dev/learn/passing-data-deeply-with-context
- React: Reusing Logic with Custom Hooks
  https://react.dev/learn/reusing-logic-with-custom-hooks
- React: useEffect
  https://react.dev/reference/react/useEffect
- React: useReducer
  https://react.dev/reference/react/useReducer
- React: State as a Snapshot
  https://react.dev/learn/state-as-a-snapshot
- React: You Might Not Need an Effect
  https://react.dev/learn/you-might-not-need-an-effect
- Martin Fowler: Passive View
  https://martinfowler.com/eaaDev/PassiveScreen.html
