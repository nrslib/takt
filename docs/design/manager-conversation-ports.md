# Daemon conversation ports

This is the event-driven conversation contract. The event and process contracts in `src/core/daemon/` are the source of truth. Composition in `runDaemon.ts` and the CLI startup path are completed during final integration.

## Ownership and execution

The daemon owns admission, two durable queues, conversation state, snapshots, delivery routes, and lightweight watchers. It never runs business preparation, AI, MCP tools, task execution, or synchronous business-store scans. Each conversation has one persistent child process for those operations. Human input and event turns share that conversation and provider session.

There are exactly two model queues: human input (including inquiry answers) and other events (including director messages). At the next turn boundary, human input has priority. Acceptance order is preserved within each queue and conversation. A running turn is never preempted by a new message. Interrupt targets its operation ID and generation and never removes queued input.

Watchers use asynchronous, bounded observations. They emit events for changes and anomalies, without calling a model on a clock. There is no scheduled model patrol or observer child process. Failed or interrupted work is rerun only on an explicit human request. Retrying a failed persistence operation reuses the stored result and never reruns AI.

## Admission and control

`createDaemonConversationInput` adapts the TUI and Slack `ConversationInput` to `DaemonIngress`. Assignment resolution uses registered routing data supplied by composition, not goal/task stores or provider configuration. Client-side repository normalization connects repositories in a workspace to the same conversation.

An attachment fixes its authenticated speaker, assignment, port binding, and optional CLI provider/model overrides. Each human event carries those overrides. Changing the speaker through a later submit is rejected. Director accepts only conversation messages. Inquiry answers retain their target, question ID, source, and permission sentence; the child validates business permissions and current question state.

`DaemonIngress.accept` durably saves an event before returning `accepted` with event ID, operation ID, and accepted sequence. Capacity, storage, and shutdown rejection never count as acceptance. Admission does not wait for a turn to finish. Proposal approval and dismissal retain the selected revision through the event; the child checks it again when executing, so a stale proposal is never implicitly approved.

Snapshot and interrupt requests bypass the model queues. Interrupt checks conversation, operation ID, and generation. Stale control requests cannot interrupt a later turn. Closing a screen only detaches that screen; it does not remove accepted events. Stopping admission rejects new work while already-started persistence and delivery operations finish.

## Snapshot and IPC

Snapshots are asynchronous and lazy. The saved `turnState` is a small DTO for a child; the screen consumes `items` separately. Starting a turn reads only the DTO and cancels the unused item stream. The screen receives state, assignment, goal, inquiry, and display-event values; the daemon does not construct these by synchronously scanning business stores.

IPC authenticates the daemon owner (PID/start identity/version/CLI path) and a private random capability before accepting requests. A client can submit, read, or detach only its own attachment. TUI binding and local speaker are verified at the server boundary. Director messages do not use the screen socket.

Unix endpoint directories are owned directories with mode 0700; socket mode is 0600. A stale endpoint is removed only after owner and listening checks. Directory preparation, socket inspection, permissions, and cleanup use asynchronous filesystem operations. Windows uses a named pipe.

JSON frames are bounded at 1 MiB. Large snapshot and output values use fragmented transfers. Control responses can pass a paused snapshot, transfers retain item boundaries, and a superseded read is cancelled. A slow or disconnected receiver releases reads and attachments; it cannot prevent another connection from accepting input. A partial read never replaces a committed display baseline.

## Slack

Composition passes already-resolved repository assignments, language, channels, allowlists, and tokens to `createDaemonSlackPorts`. Slack adapters do not load project configuration, resolve Git roots, or instantiate goal/task/inquiry stores.

Socket Mode ACK confirms transport receipt, independently of business acceptance. After the event is durably admitted, its originating thread receives an acceptance reply. Completion is delivered later to that same thread and operation. Requests derived from a Slack event use a stable request ID to deduplicate transport retries. Bot messages, DMs, unconfigured channels, and users outside the destination's allowlist are ignored.

Manager and director channels may be shared. A bound inquiry thread routes only to its manager and uses that manager's allowlist; other speech in a director channel routes to director. Approval buttons carry conversation ID and revision. Modal confirmations are bound to the original team, channel, user, and thread. Wrong-origin confirmations neither grant permission nor consume the original modal.

Inquiry changes arrive through `delivery.deliver` from watchers or the state owner. Slack performs no initial or five-second whole-inquiry scan. The posted inquiry uses the delivered question; answering a bound thread reads its current question through the snapshot interface, and the child revalidates it on execution. Binding reads and writes are asynchronous. An unreadable binding fails closed, rather than treating the answer as ordinary conversation. Existing inquiries remain accessible through the TUI.

Persistent request-to-thread routing across daemon restarts requires a delivery-state persistence interface in final integration. Current live ports preserve the exact originating thread; durable event acceptance alone does not promise restored Slack routing after restart.

## Child state requests and director delivery

A child uses the finite `DaemonBus.request` protocol. `tellDirectorManager` submits `accept_director_message` with the current `TurnIdentity`, event/request IDs, target conversation, timestamp, and text. It waits only for durable admission, never for the manager reply, and never reconnects to its own daemon through IPC.

The dispatcher validates active turn, operation, generation, cancellation, and shutdown. The state owner checks authorization and assignment scope. The target manager receives `director_message` on the other-event queue. A director message is not a human merge instruction unless the original human explicitly authorized that merge.

`connectedPorts` supplies delivery metadata for `get_delivery`. The state owner must persist and deduplicate `notify_director` before using screen/Slack delivery. Delivery success is not inferred from notification persistence. Replies, failures, and interruptions retain their operation ID. An accepted director message is not automatically resent after failure or disconnection.

## Approval and recovery

Proposal revision and conversation-state version are separate. The child reserves an approval before external side effects through a conditional `save_conversation` request. A reservation fixes the revision, repository, and generated goal ID. Repeated requests with the same operation ID must be idempotent; changed content or an unexpected state version is rejected.

After registration succeeds, the saved receipt identifies the existing goal, so replay does not register another goal. An unresolved reservation prevents overwriting its input. A crash after an external side effect requires reconciliation of saved facts, never blind repetition.

Event persistence follows accept → started → result → settled. On restart, queued events retain their order. Running events become interrupted. Settling events apply their already-saved result without invoking the provider again. Stale child launch IDs, operation IDs, and generations cannot update conversation state.

## Final integration

Wire the adapter and its routing resolver to the dispatcher and async conversation owner. Connect state changes and watcher inquiry events to Slack delivery. Supply resolved Slack configuration before creating the ports. Wire child director requests to the dispatcher/state owner, including authorization, durable notifications, and connected-port metadata. Remove the old daemon polling and self-IPC callers, then enable the synchronous-API lint for the final daemon reachability set.
