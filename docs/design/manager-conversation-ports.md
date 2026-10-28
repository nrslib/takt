# Manager conversations owned by the daemon

This is a developer design note, outside the three-language translation requirement that applies to the README and user documentation.

This document records the design and original rollout plan for daemon-owned manager conversations. The local daemon service/IPC (A), TUI IPC client (B), and user documentation (C) are implemented in the current codebase. Slack Apps, HTTP Webhooks, director, transcript storage and conversation-history summaries remain future work. No dependencies, conversation locks, application request queues, unused port configuration or general plugin registry are introduced.

Before this migration, `runManager.tsx` created the provider plan, prepared MCP, and created `createManagerConversationSession` in the TUI process. `conversationSession.ts` kept `sessionId`, `pending`, `generation`, `active`, and `registering` in memory. `ManagerView.tsx` invoked it directly, polled saved events, and supplied a callback for permission-file updates. Closing the TUI aborted the session. Separately, `runDaemon.ts` created per-project event managers; `runEventManager.ts` reset its session before each event. The migration replaced the human conversation path while retaining the existing goal, task, inquiry, permission and event files as sources of truth.

## 1. Conversation record

**Implemented files:** `src/infra/conversations/schema.ts`, `store.ts`, and the daemon-owned `src/features/manager/conversationService.ts`. They use `getGlobalConfigDir()` from `src/infra/config/paths.ts` and the atomic replacement pattern in `src/infra/config/project/sessionStore.ts`. The storage schema composes lower-level goal schemas and port-independent data definitions; it does not import manager feature types.

Resolve the global directory once at process startup: `realpath(resolve(getGlobalConfigDir()))`, creating the private directory first if absent. Thus a nonempty `TAKT_CONFIG_DIR` takes precedence over `~/.takt`, including when it is relative to the launching CLI's directory. Pass the resolved absolute directory to the daemon and clients. Store records at `<configDirectory>/conversations/<conversationId>.json`. Only the winning daemon owner can write these files. Clients obtain snapshots through the service; they never update records or use persona-session/input-history storage for manager conversations.

The record has exactly the following information. All nullable fields must be present, with `null` representing absence. Optional properties inside existing goal summaries retain their existing meaning.

| Field | Type / required | Meaning and validation |
|---|---|---|
| `schemaVersion` | integer literal `1`, required | Reject unsupported versions explicitly; do not silently reset or introduce legacy readers. |
| `id` | string, required | `manager-` plus 64 lowercase SHA-256 hexadecimal digits, as defined in §2; must match filename and assignment. |
| `agent` | nonempty string, required; currently `manager` | Conversation owner role, separate from assignment and human identity. This does not enable director. |
| `assignment` | repository or workspace identity, required | `{kind:'repository', repositoryDirectory:string}` with canonical Git root, or `{kind:'workspace', workspaceId:string}` with existing UUID. Resolve membership afresh when acting. |
| `counterpart` | `{namespace:string, id:string}`, required | Logical audience: initially the local human operating this assignment. It is not an OS process, speaker, or transport connection. |
| `lastSpeaker` | `{namespace:string, id:string} \| null`, required | Last accepted actor identity, with no utterance text; adapters authenticate/establish it. Multiple speakers can address one audience. |
| `provider` | nonempty canonical provider name, required | Provider resolved by the manager plan. |
| `model` | `string \| null`, required | Resolved model, or `null` when the provider chooses its default. |
| `sessionId` | nonempty string or `null`, required | Provider-owned history reference; never a credential. |
| `bindings` | array of `PortBinding`, required | Opaque adapter-owned endpoint mappings, as defined in §6. These do not mean a connection is currently open. |
| `revision` | nonnegative safe integer, required | Durable monotonically increasing summary generation, including invalidations. Never reset on reconnect. |
| `pending` | `{revision:number, summary:ManagerGoalSummary, repositoryDirectory:string} \| null`, required | Only the proposed goal awaiting approval; its revision must equal the record revision. The repository must currently belong to the assignment. |
| `approval` | `null` or approval object below, required | Latest approval receipt or incomplete registration reservation, not an approval history. |
| `running` | `null` or running object below, required | Whether an accepted operation is still owned by a daemon incarnation. `null` is idle; no redundant boolean. |

`approval` contains required `revision` (positive safe integer), `goalId` (UUID), `repositoryDirectory` (canonical path), and `state` (`reserved` or `registered`). A reserved approval retains the corresponding `pending` unchanged, so its validated registration input is recoverable. A registered receipt may remain after `pending` is cleared. Do not persist a second copy of the summary in the receipt.

`running` contains required `operationId` (UUID), `kind` (`message`, `approve_summary`, `dismiss_summary`, `answer_question`, `pause_goal`, `resume_goal`, or `abort_goal`), and `owner` (`{pid:number, identity:{startTime:string}}`). Owner identity comes from the daemon registration, not from a client. The operation's message, response, prompt, tool arguments, and error text are absent.

Example of an idle conversation awaiting approval (identifiers and paths are illustrative; derive the ID with §2 in code):

```json
{
  "schemaVersion": 1,
  "id": "manager-aa76d4b8308b49fe3620b02ac9968d99171f0d92af8442d35583a71738dcc309",
  "agent": "manager",
  "assignment": { "kind": "repository", "repositoryDirectory": "/work/example" },
  "counterpart": { "namespace": "local", "id": "operator" },
  "lastSpeaker": { "namespace": "local", "id": "operator" },
  "provider": "codex",
  "model": null,
  "sessionId": "example-provider-session",
  "bindings": [
    {
      "port": "tui",
      "key": "[\"manager\",\"repository\",\"/work/example\"]",
      "counterpart": { "namespace": "local", "id": "operator" }
    }
  ],
  "revision": 4,
  "pending": {
    "revision": 4,
    "repositoryDirectory": "/work/example",
    "summary": {
      "objective": "Add a health command",
      "outOfScope": ["Remote monitoring"],
      "acceptanceCriteria": ["The command reports local readiness"],
      "constraints": ["Use the existing CLI"]
    }
  },
  "approval": null,
  "running": null
}
```

Validate unknown JSON strictly and check cross-field invariants on both read and write. Missing file means a new record; malformed JSON, permission failure, or unsupported schema means an error, never a fresh empty conversation. Write a complete allowlisted record to an exclusive temporary file in the same directory, mode `0600`, then rename over the destination; directory mode is `0700` on Unix. Clean up the temporary file on failure without replacing the previous good record. Do not spread provider responses or IPC envelopes into persisted objects. Atomic replacement prevents partial JSON; it is not a multi-file transaction or a power-loss durability guarantee.

TAKT does not persist human utterances, manager replies, streamed text, prompts, or compressed conversation history in this record, sidecar transcripts, debug logs, or IPC logs. The pending goal proposal above is the explicitly permitted business object, not a history summary. After registration the goal lives in its existing goal file. Existing event processing may write goal work-log results as it already does; it must not turn human conversation replies into work-log transcripts. Provider-managed session storage remains the provider's responsibility. Log only operation IDs, categories, and sanitized diagnostics without request/response bodies or session IDs. These rules implement `SCN-STORE-P1`, `SCN-STORE-N1`, `SCN-DAEMON-P1`, and `SCN-PORT-P1`.

## 2. Conversation identity and assignment changes

**Implemented files:** `conversationService.ts` selects records through `src/infra/conversations/identity.ts`; assignment resolution reuses `src/features/manager/startupResolution.ts` and `assignment.ts`. `runManager.tsx` opens the TUI through the IPC client and TUI port.

Resolve startup directory to the canonical Git root and its workspace using the existing startup resolver. Workspace selection outside a repository remains a TUI concern. The daemon validates that selection and resolves current membership again. Build an unambiguous JSON tuple:

```typescript
const identity = assignment.kind === 'workspace'
  ? ['manager', 'workspace', assignment.workspaceId]
  : ['manager', 'repository', assignment.repositoryDirectory];
const conversationId = `manager-${createHash('sha256')
  .update(JSON.stringify(identity), 'utf8').digest('hex')}`;
```

Use the exact canonical path produced by the existing resolver, including its Windows drive/path spelling; do not derive IDs from basename, caller cwd, or worktree display names. Store and verify the assignment as well as its hash, so an unexpected collision or inconsistent record is an error. No assignment index file is needed. The configuration directory scopes the store; different configuration directories intentionally have independent conversations.

The TUI adapter owns its endpoint key `JSON.stringify(identity)`. Both a reopened TUI and a second simultaneous TUI resolve that key to the same conversation ID. Each has a separate ephemeral attachment ID, but neither creates a new provider session merely by opening. Snapshot returns the current pending proposal, revision, approval receipt, and running state, without transcript restoration (`SCN-DAEMON-P3`, `SCN-DAEMON-P4`).

Change assignment means change conversation ID. Workspace member additions/removals keep the workspace ID and therefore the conversation ID; revalidate every action against current membership. Repository-to-workspace promotion changes identity. Finish any already accepted turn under its captured assignment and revalidate its resulting repository before saving a proposal. Then publish an assignment-change notice and require attachments to reopen the newly resolved assignment before the next mutation. Do not migrate the old session or pending proposal automatically. In particular, an old revision cannot be approved under a new assignment. If an approval was already reserved, finish/reconcile it under its original assignment before switching; loss of access returns a recoverable error, never an alternative repository. This retains stable assignment identity without carrying authorization or goal proposals across ownership boundaries.

## 3. Provider session reuse and reconstruction

**Implemented files:** `src/features/manager/turnExecutor.ts` owns provider/MCP execution, while `conversationService.ts` supplies and saves human session state. It reuses `conversationPlan.ts`, `turnContext.ts`, and the provider adapters. Preflight and `connectManagerMcp` are owned by daemon composition rather than `runManager.tsx`.

Resolve provider, model, options, permissions, language, MCP configuration, and assignment at the service boundary. Pass those resolved values to the executor, rather than resolving them independently in the executor or TUI. Persist only provider, model, and session ID; do not copy options or credentials into records. A changed provider/model invalidates the stored session ID. Within one daemon lifetime, also invalidate when the resolved MCP or system-prompt context changes. On daemon restart, attempt the saved session with the current resolved plan; any provider rejection must be classified rather than hidden by a generic retry.

For a known missing/expired/unresumable provider session, clear and save `sessionId`, then start a fresh session. Before invalidating a pending proposal for a new message, capture it in turn-local memory. The first fresh call includes the current user request, the captured pending proposal with its repository and revision (marked as context, not approval), current assignment, and the latest readable goal/task state from `buildManagerGoalSummary` / `buildGoalMemory`. State read failures are diagnostics, not invented empty goals. Nothing reconstructed here is a transcript. Merely opening a TUI does not invalidate pending or call the provider.

If unavailability is discovered by a failed call, replay the current request once only when the provider's explicit failure classification establishes a rejected resume and no tools ran. Otherwise end the operation, clear the unusable session reference, and let the next user request start fresh. Never replay tool side effects under a fresh session. An unavailable session is different from an authentication, network, or arbitrary provider error.

Preserve the bounded overflow recovery in `handleUserMessage`: only a `prompt is too long` failure before any tool use, without cancellation or generation change, permits one fresh-session retry. Include the same reconstruction context; do not chain a second recovery retry if another failure follows. Preserve prepared MCP ownership and dispose it after the final attempt. Generic failures and tool-used overflow fail without replay. After a valid result, save the returned session ID together with pending/running changes before terminal delivery. Overflow tests in `manager-turn-executor.test.ts`, durable session-recovery tests in `manager-conversation-service.integration.test.ts`, and event-session tests in `daemon-conversation-events.integration.test.ts` verify this contract (`SCN-SESSION-P1`).

## 4. Pending summaries and approval recovery

**Implemented files:** `schema.ts`, `store.ts`, and `conversationService.ts` persist approval reservations. The registration boundary in `src/infra/goals/service.ts` accepts a reserved ID, with the related goal store/Git changes needed to avoid creating a second goal. `useManagerSummaryApproval.ts` and `ManagerView.tsx` pass revisions through IPC.

The service owns a durable safe-integer `revision`. Increment it when an accepted human message (including an explicit summary request), answer, goal control, explicit dismissal, reset, or cancellation invalidates a proposal. A valid provider-produced proposal is stamped with that turn's revision and saved before delivery. An error clears any proposal from that turn; cancellation increments revision so late results cannot restore it. Refuse further changes at safe-integer exhaustion instead of wrapping. Opening, disconnecting, snapshot reads, provider-session replacement within the same turn, and event turns do not change the human revision. Reset is an internal service operation, not a new TUI feature.

An idle `pending` is approvable only when both its revision and the record revision equal the submitted revision. Recheck after resolving current repository membership. If they differ or no proposal remains, return `stale_summary` and the latest snapshot without any goal creation or new UUID. Dismissal also names the expected revision; typing that dismisses a displayed proposal must send an immediate dismissal in B, and cannot queue it behind another operation. A rejected dismissal leaves the authoritative proposal intact and refreshes the screen.

Approval is a separate operation, not a provider call:

1. Claim the conversation synchronously as in §8. Validate expected revision, assignment, and pending summary using the current schemas, including safe display strings and repository selection for workspaces.
2. Allocate a UUID only if this revision has no reserved goal ID. Save `{state:'reserved', revision, goalId, repositoryDirectory}` with the pending proposal and running owner **before** calling any goal-creation code. A failed reservation write means no goal/branch/event side effects and no acceptance.
3. Inspect the exact reserved goal ID in the exact saved repository. Distinguish confirmed absence from unreadable/corrupt/unauthorized storage. Read errors end with a diagnostic and retain the reservation. Do not use catch-all `get` failure as absence.
4. If the goal exists, verify that it matches the reserved proposal and repository. Return that goal as the registration result; never invoke `createGoal` again, generate a new UUID, or overwrite the existing goal. If it conflicts, return an explicit inconsistency error.
5. If confirmed absent, create using the reserved ID and frozen proposal, preserving existing branch validation and assignment checks. Persist goal before marking the receipt registered.
6. Save `approval.state='registered'`, clear pending, advance revision, and clear running. Return `goal_registered` with the reserved ID. The receipt retains its approved revision. If the final record write fails, the durable reservation still leads to step 3 on retry.

While `reserved` remains unresolved, do not allow another proposal to overwrite its input or clear it by reset/dismissal. A new mutation returns an explicit registration-recovery error, not a permanently stuck `running`/busy flag. Retrying approval of that reserved revision retries the reconciliation. Once registered, replaying the receipt's revision returns the existing goal result without approving any older proposal; other stale revisions remain rejected. Retain only the latest receipt, and replace it only upon reserving a later approval.

`createGoal` currently performs project registration, branch preparation, branch creation, goal persistence, and `saveManagerEvent({kind:'registered'})` separately. Reserving an ID does not make this sequence atomic. Recovery must distinguish these stops:

| Stop position | Required action with the same reserved ID |
|---|---|
| Before reservation is saved | Nothing was accepted or created; a fresh approval can allocate an ID. |
| Reservation saved; no goal or branch side effects | Retry creation using the saved ID, never a new one. |
| Branch may have been created; goal absent | Inspect Git refs matching that goal's existing `goal-<ID prefix>` naming and the intended inputs. Do not manufacture another timestamped branch on blind retry. If a unique matching branch cannot be verified safe to reuse, return a registration-recovery diagnostic for explicit repair; do not delete an uncertain ref. The future registration boundary must return this condition explicitly. |
| Goal exists; registered event may not have been written | Do not recreate the goal. Check existing inbox events and goal work log/task state. Preserve a present registered event; if delivery cannot be distinguished from an already consumed event, surface the uncertainty rather than emitting another event blindly. The goal remains registered; normal daemon patrol can inspect it. |
| Registered event exists or was consumed; receipt not saved | Return the existing goal and save the registered receipt; do not emit another registered event on reapproval. |
| Registered receipt exists | Confirm the goal exists and return it. If it was removed or is unreadable, report that condition; do not recreate it from an old approval. |

The required guarantee is one goal per approved revision, not exactly-once provider execution or a new event-delivery transaction. Ambiguous branch/event recovery is visible as such and must be covered in A's failure tests. Do not change general goal event retry rules or add a conversation lock/outbox to hide it. These procedures implement `SCN-STORE-P2`, `SCN-STORE-N2`, and `SCN-STORE-P3`.

## 5. Running state, disconnect, and daemon restart

**Implemented files:** `conversationService.ts` owns live controllers and operation promises; `schema.ts` stores running metadata. `src/features/daemon/runDaemon.ts` uses the identity from `src/infra/daemon/owner.ts`. The existing daemon-owner election remains the sole writer authority; conversation-file locks are not added.

For each mutating request, synchronously claim its already loaded conversation in memory before the first `await`. Persist running metadata and any initial invalidation/reservation before sending `accepted`; only then invoke provider or domain side effects. Validation/persistence failure before acceptance releases the claim and sends `error`, with no provider call. Memory contains text only for the live turn, plus its AbortController and operation promise. There is no durable input to replay after a crash.

On success, failure, or explicit abort, await provider/MCP cleanup, save resulting session/pending/revision with `running:null`, and then publish terminal result and idle state. Keep the in-memory claim until this save succeeds. A terminal-save failure must be reported; make the conversation unavailable with a storage error until persistence can be recovered, rather than allowing overlapping writes or pretending to be idle. Do not hold a permanently busy record after recovery.

Socket close removes an attachment only. It neither aborts the daemon controller nor cancels an accepted operation. Replies to a vanished TUI may be lost, but pending and domain results are saved. Another attachment can receive live updates, and a later open sees the latest snapshot (`SCN-DAEMON-P2`).

Before serving a restored record, compare `running.owner.pid` and `identity.startTime` with the current daemon owner. A different incarnation means the old operation was interrupted: clear running, clear the potentially incomplete provider session, preserve the last committed pending/reservation, and atomically save before accepting input. Return an interruption notice in that first open snapshot; no need to store error text. A matching current owner without a live operation promise is also an inconsistency to reconcile as interrupted, not evidence of work still running. Never replay a missing utterance. Recover reserved approval by §4 when explicitly retried. This prevents leftover running metadata from causing permanent busy, including PID reuse (`SCN-DAEMON-P5`).

Explicit daemon stop is different from ordinary idle exit: stop accepting, announce shutdown, abort/drain live operations, dispose resources, flush interrupted state where possible, then release owner and endpoint. A forced kill can leave running metadata; the next incarnation repairs it. TUI Ctrl+C performs detach; its explicit Escape interruption uses a distinct request naming the current operation ID. A delayed abort cannot cancel a newer turn.

## 6. Conversation ports

**Implemented files:** `src/features/manager/conversationPort.ts` defines the service-facing contracts, with `tuiConversationPort.ts` and `conversationIpcClient.ts` implementing the local TUI path. Persisted opaque identity data lives in `src/infra/conversations/schema.ts` and does not depend on this feature module. No Slack/Webhook adapter, registry, settings, or credential fields are created.

The adapter receives external input, resolves its own endpoint to an assignment/conversation, establishes speaker identity, and calls the service. The daemon service owns validation, mutation, persistence, and execution. A separate delivery interface formats output for the adapter. The following TypeScript excerpt documents the implemented contract; goal and inquiry data reuse their existing lower-level types. `ConversationSnapshot` is the logical state reconstructed by the screen, not a service return value or a single wire object. The service returns a pull-based `SnapshotRead` instead of building all display arrays. Snapshot delivery uses the same read contract.

```typescript
import type { Goal, GoalAnswerInput, GoalQuestion, ManagerGoalSummary }
  from '../../infra/goals/schema.js';
import type { InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import type { WritablePermissionScope } from './scopedPermissionStorage.js';
import type { ManagerAssignment } from './startupResolution.js';

interface Actor { namespace: string; id: string }
type Assignment =
  | { kind: 'repository'; repositoryDirectory: string }
  | { kind: 'workspace'; workspaceId: string };
interface PortBinding { port: string; key: string; counterpart: Actor }
interface PendingSummary {
  revision: number;
  repositoryDirectory: string;
  summary: ManagerGoalSummary;
}
type QuestionTarget =
  | { goalId: string; repositoryDirectory: string }
  | { goalId: null; owner: InquiryOwner };
type ConversationCommand =
  | { kind: 'message'; text: string }
  | { kind: 'approve_summary'; revision: number }
  | { kind: 'dismiss_summary'; revision: number }
  | { kind: 'answer_question'; target: QuestionTarget; questionId: string;
      answer: GoalAnswerInput;
      permission?: { scope: WritablePermissionScope; sentence: string } }
  | { kind: 'pause_goal' | 'resume_goal' | 'abort_goal'; goalId: string }
  | { kind: 'abort_turn'; operationId: string };

interface ConversationState {
  conversationId: string;
  assignment: Assignment;
  revision: number;
  pending: PendingSummary | null;
  approval: { revision: number; goalId: string; repositoryDirectory: string;
    state: 'reserved' | 'registered' } | null;
  running: { operationId: string; kind: string } | null;
  interrupted: boolean;
}
interface ConversationSnapshot extends ConversationState {
  goals: Array<Pick<Goal, 'id' | 'objective' | 'status' | 'executionStatus'>
    & { repositoryDirectory: string }>;
  inquiries: Array<{ target: QuestionTarget; question: GoalQuestion; objective?: string }>;
  events: Array<{ id: string; message: string }>;
}
type SnapshotValue =
  | { kind: 'assignment'; assignment: ManagerAssignment }
  | { kind: 'state'; state: ConversationState }
  | { kind: 'goal'; goal: ConversationSnapshot['goals'][number] }
  | { kind: 'inquiry'; inquiry: ConversationSnapshot['inquiries'][number] }
  | { kind: 'display_event'; event: ConversationSnapshot['events'][number] };
type SnapshotItem = SnapshotValue | { kind: 'remove'; key: string };
type SnapshotMode = 'initial' | 'delta';
interface OutputVersion {
  revision: number;
  stateSequence: number;
  operationId: string | null;
}
interface SnapshotRead extends OutputVersion {
  transferId: string;
  conversationId: string;
  mode: SnapshotMode;
  items: AsyncIterable<SnapshotItem>;
  complete(): void;
  cancel(): void;
}
type Submission =
  | { kind: 'accepted'; operationId: string }
  | { kind: 'busy'; operationId: string }
  | { kind: 'error'; code: string; message: string };
type OperationResult =
  | { kind: 'reply'; message: string }
  | { kind: 'goal_registered'; goal: Goal }
  | { kind: 'answer_saved'; answerSaved: boolean; message: string }
  | { kind: 'error'; code: string; message: string; answerSaved?: boolean };
type PortOutput =
  | { kind: 'snapshot'; read: SnapshotRead }
  | { kind: 'reply' | 'progress'; operationId: string; message: string }
  | { kind: 'pending' | 'running'; state: ConversationState }
  | { kind: 'notice'; id: string; message: string }
  | { kind: 'inquiry'; target: QuestionTarget; question: GoalQuestion }
  | { kind: 'result'; operationId: string; result: OperationResult };

interface ConversationInput {
  open(input: { conversationId: string; assignment: Assignment;
    binding: PortBinding; speaker: Actor },
    delivery: ConversationDelivery): Promise<{
      attachmentId: string; read: SnapshotRead;
    }>;
  submit(input: { attachmentId: string; requestId: string; speaker: Actor;
    command: ConversationCommand }): Promise<Submission>;
  snapshot(attachmentId: string): Promise<SnapshotRead>;
  detach(attachmentId: string): void;
}
interface ConversationDelivery {
  deliver(conversationId: string, output: PortOutput,
    version: OutputVersion): Promise<
    { kind: 'delivered' } | { kind: 'unavailable'; reason: string }>;
}
interface ConversationPort<Endpoint> {
  resolve(endpoint: Endpoint): Promise<{
    assignment: Assignment; conversationId: string;
    binding: PortBinding; speaker: Actor;
  }>;
  delivery: ConversationDelivery;
}
```

`ConversationPort.resolve` owns the endpoint interpretation and returns `conversationId`, `assignment`, `binding`, and `speaker`; the adapter passes all four to `ConversationInput.open`, with its delivery adapter as the second argument. The service resolves the current assignment and derives the expected ID using §2, then compares it with the received `conversationId` before opening a record or saving a binding. A missing ID is invalid input; a mismatched ID is rejected without opening another record or silently substituting the expected ID. On a match, use that received, validated ID to select the record and return the same ID in the snapshot. There is no omitted-ID recomputation fallback. A client-supplied ID alone is not authority to access a conversation. The store validates only the generic `port`, `key`, and counterpart shape: no `switch(port)` for `tui`, `slack`, or `webhook`. The `port` string is data, not an instruction to instantiate a transport. Bindings persist as part of a record and are selected by their adapter; future external assignment mappings belong to that adapter. They are not network destinations or credentials understood by storage.

Register an attachment before capturing its open read. Capture one immutable `ConversationState` with matching conversation ID, assignment, revision, pending, approval, running, and interrupted flag. An `initial` read yields this complete state first, then the display assignment, individual goals, pending human inquiries, and visible display events. The snapshot has no `notice` item. Work records older than the attachment's repository startup boundary and notifications older than its start time are excluded before formatting or transfer. Equal timestamps remain visible. A repository added later has no initial work-record boundary; its notifications still use the attachment start time.

Subsequent `delta` reads compare stable item keys and SHA-256 content hashes against the last completed read on that attachment. They yield only added/changed complete values and `{kind:'remove', key}` for missing items; an unchanged read has zero items. State and assignment are sent only when changed. Inquiry keys use owner, repository, goal and question identities in a fixed field order. The client applies values through a Map, stages removals until completion, and reconstructs the ordered display list on transfer completion or failure, rather than per item or socket chunk. Authoritative state still updates immediately. An initial completion replaces its list; a delta completion preserves untouched values. An incomplete transfer can display complete received values and diagnostics without applying removals or initial replacement. Reapplying a value or deletion on a later transfer is idempotent; deleting an already absent key leaves the list unchanged.

A `SnapshotRead` has one consumer. Reading its iterator to exhaustion does not commit the baseline. The adapter calls `complete()` only after successfully writing `transfer_end`, or after complete consumption in a direct adapter. It calls `cancel()` and returns the item iterator for failure, cancellation, or replacement. Only the latest fully consumed read can commit; late completion of a canceled/replaced read does nothing. Detach discards the attachment's baseline and projections. Reconnect creates a new attachment and initial read, while the screen keeps its displayed-event deduplication. Separate clients never consume one another's changes. Neither baselines nor transfer state are persisted.

`transferId` is fresh for every read. `stateSequence` is a daemon-incarnation-local monotonically increasing sequence for every authoritative human conversation state change, including running changes within one revision. Capture it with the state; correlate it with revision and the current operation ID. These values order delivery (§9), not authorization or approval. Sequence exhaustion requires a fresh daemon incarnation before another update. Transfer IDs and sequences are ephemeral: never add them to conversation records. Neither opening nor reading advances the durable summary revision. Ordinary `pending`/`running` outputs also carry a complete captured `ConversationState`, not separate partial fields: coalescing an earlier pending update into a later running update must still deliver the latest pending, approval and revision together. The output kind identifies the change being announced, not a second state representation.

**Sequential business reads in A:** use pull-based iteration in `src/infra/goals/store.ts` and `standalone-inquiries.ts`, pending-inquiry producers in `pending-inquiries.ts`, and the display-event projection in `savedEvents.ts`. Do not call `GoalStore.list`, `listPendingInquiries`, or `StandaloneInquiryStore.listPending` and then slice/iterate their arrays for this path. Enumerate authorized repository directories and goal entries, read/validate one goal file at a time using the existing private-path and identity checks, then project a display goal or yield its pending human questions and visible display events. Standalone inquiries come from the resolved owner's directory; validate filename/ID, owner/assignment access, recipient and pending state before yielding. Keep corrupt/unreadable-record diagnostics visible rather than treating them as missing business data. Do not add locks or change the existing files/schemas.

Preserve current display ordering: goal directory order within assignment repository order, inquiry creation time then repository/goal/question ID, and stable display-event order. The manager read uses `GoalStore.iterateProjected` to cache only validated display projections, pending questions and visible events. It compares file size, modification/change time and filesystem identity; unchanged files avoid JSON reads. Safe ancestor/file-type and identity checks still run on cache hits. Removed files evict their entries; read/validation errors remain failures rather than returning stale cached values. Language or notification-policy changes invalidate the corresponding projections. Ordinary GoalStore reads and goal persistence retain their existing contracts. The cache does not retain complete Goal records or hidden historical text. A scan observes each validated record when read, not an atomic transaction across all goals; the captured conversation state stays internally consistent.
Attachments are live delivery registrations in daemon memory, distinct from durable bindings. Delivery failure drops/marks that attachment unavailable without rolling back a completed operation. Reply/progress are transient; snapshots restore pending, and existing inquiry/notification files supply durable business information. Delivery consumes item reads incrementally and uses §9's item fragmentation for every potentially large output, including ordinary pending, inquiry, notice, reply, progress, and result messages. No path embeds a complete logical snapshot in one event or response. A port without a return path reports unavailable; this interface promises no store-and-forward delivery. The adapter authenticates identities; the service also verifies attachment ownership, assignment, target repository, question owner, current question state, and permitted action. An arbitrary speaker string is never sufficient authorization.

Persisting a new or changed binding uses the same per-conversation admission as every record mutation. If a turn owns the conversation, return busy for a new binding rather than racing its full-record write or saving it later. Opening an already saved binding only attaches in memory and can proceed while running. All record updates merge into the service's authoritative current state; never write a snapshot captured before another update. This keeps reconnect and second-TUI reads available without creating an unguarded writer.

For answers, replace `ManagerView`'s `appendPermission` closure with the data in `answer_question`. Load the actual inquiry before touching permissions; accept permission text only for an allowed approval and its selected writable project/workspace/global scope. Resolve project membership, require the matching workspace, validate the final human-confirmed single-line sentence, then invoke `appendScopedPermission` in the daemon followed by the existing answer persistence/event/auto-run path. Do not accept a file path or function from IPC, or expose permission append as an AI tool. Preserve `answerSaved` when later event/auto-run work fails; if permission append succeeds but answer save fails, report that partial outcome and do not automatically repeat the answer request. Standalone inquiry ownership must match the resolved assignment as well. Goals, questions, notices, and permission files retain their current schemas in A/B; future Webhook answer provenance needs separate work (§11).

These boundaries satisfy `SCN-PORT-P1` and give the three required port responsibilities explicit owners: receive/resolve, deliver, and accept structured human answers.

## 7. Shared execution with separate contexts

**Implemented files:** `turnExecutor.ts`, `conversationService.ts`, `src/features/manager/runEventManager.ts`, and the daemon composition in `runDaemon.ts`. The existing event inbox, patrol budget, 30-minute event timeout, failed-event retention, work-log updates, permission judge, and MCP disposal contracts remain in place.

The executor runs one provider turn from a resolved plan and a supplied context; it does not select a conversation record or port. Human context contains that conversation's session reference and pending/revision state, owned by the conversation service. Each event context starts with no session ID and no pending proposal and is owned by `runEventManager`. They may reuse plan/preflight/MCP setup when compatible, but never the mutable context or prepared per-call resources.

```text
human port -> conversation service -> executor(human context) -> human record -> port
goal inbox -> runEventManager       -> executor(fresh event context) -> goal work log
```

Replace `manager.resetConversation(); manager.handleUserMessage(...)` with direct execution using a fresh event context and `buildGoalTurnContext`, including the existing goal permission context. Event output proposing a registration summary remains an error, not a human pending update. Event session IDs are discarded after that event. Event replies continue through the existing goal work-log path; human replies go to their port. No event path can access the human record's session, revision, approval, or pending setters (`SCN-CONTEXT-P1`).

Human and event operations can run concurrently because they have separate contexts; goal mutations still use existing goal-level validation/execution protections. Busy applies per human conversation, not globally per repository or provider. Neither merge contexts nor queue an event behind a human conversation. The existing saved event inbox is domain work, not a new conversation-input queue.

The critical continuous scenario is one human conversation producing pending revision 4, an event completing while that same conversation remains loaded, then approval of revision 4. The human session ID, proposal contents, and revision must be unchanged by the event. A test that constructs a different human conversation afterwards cannot prove this isolation.

## 8. Concurrent requests without queuing

**Implemented files:** `conversationService.ts` owns the admission check. `ManagerView.tsx` and `useManagerInput.ts` reject busy requests instead of delaying `queued` messages and `operations`; the unused `ManagerQueuedMessages.tsx` path and direct-session alternative are removed.

Keep a daemon-owned map of loaded conversations. For an unloaded ID, synchronously place its initializing entry before reading the record; a second open receives a temporary busy result and can explicitly retry. Do not run two independent restore/write operations or create a second session. Attachments using an existing binding on a loaded conversation may open/read while a turn runs; adding a binding follows §6's mutation admission.

For mutations, dispatch synchronously from the socket/parser into the service: validate envelope/attachment, inspect the in-memory active operation, and set it before any assignment lookup, store write, provider setup, or other awaited work. The first valid arrival wins. Every conflicting message, approval, dismissal, answer, and goal-control request gets `busy` with the current operation ID. There is no stored input, deferred callback list, promise chain of pending mutations, automatic busy retry, or eventual execution of that rejected request. Read-only snapshot/detach bypass mutation admission. Explicit `abort_turn` targets the active operation rather than attempting to claim another one.

For example, TUI A submits text and owns operation X; Slack B submits text during X and receives busy tied to B's request. When X finishes, only A's text has been executed. B must submit again explicitly. Identical human identity across ports does not bypass admission. B's draft can remain locally editable but is never a daemon queue. This is `SCN-BUSY-N1`.

## 9. TUI adapter and local IPC

**Implemented files:** `src/infra/daemon/ipcEndpoint.ts`, `src/features/daemon/conversationIpcServer.ts`, and `src/features/manager/conversationIpcClient.ts` / `tuiConversationPort.ts`. `lifecycle.ts`, `runDaemon.ts`, daemon owner readiness, `runManager.tsx`, `ManagerView.tsx`, and the affected `useManager*.ts` hooks use the local IPC path. Transport uses `node:net`; filesystem, crypto, and path operations use Node standard modules.

### Endpoint and access

Both client and daemon derive `h = sha256(canonicalConfigDirectory).slice(0, 24)` in one helper. On macOS/Linux use `/tmp/takt-<uid>-<h>/manager.sock`; the private directory is fixed and short even for a very long `TAKT_CONFIG_DIR`. Verify it is an ordinary owned directory (no symlink), create with `0700`, and set socket mode `0600` before announcing readiness. Check the UTF-8 byte length of the complete socket path and reject lengths over 103 bytes on either Unix platform, a conservative common ceiling. Do not truncate the path. Node documents typical limits of 103 bytes on macOS and 107 on Linux. On Windows use the flat pipe name `\\.\pipe\takt-manager-<h>`; it is independent of filesystem path length. Windows removes the pipe when its owning process exits. [Node.js IPC documentation](https://nodejs.org/docs/latest-v22.x/api/net.html#identifying-paths-for-ipc-connections)

The elected daemon alone binds and cleans up the endpoint. On Unix, when an endpoint remains, check the recorded daemon process identity and probe connection. Never unlink a live endpoint or another file/symlink. Remove only a verified owned stale socket after the former owner is confirmed dead/replaced; otherwise fail visibly. `server.close` handles normal socket unlink; guarded cleanup covers failed startup. Windows needs no socket-file removal; a name collision is a startup error, not a reason to terminate an unknown server.

Do not treat pipe naming or Unix chmod as Windows authentication. A creates a per-incarnation random 256-bit capability in a private daemon IPC state file under the canonical config directory, written only by the daemon and never in conversation records/logs. Its state includes PID/start identity; clients read it only after verifying the current owner. Require a first `hello` with that capability and protocol version before accepting other frames; compare tokens without logging them. On Unix the state file is `0600`; on Windows it inherits the private user configuration directory's ACL, which must restrict other users. Node `net` supplies no portable peer-user/ACL enforcement API; capability secrecy depends on that directory's access controls. A must test that a client without the capability cannot open/submit on Windows as well as Unix; chmod alone is not evidence. No HTTP listener, remote authentication setting, or native dependency is added.

Readiness means the endpoint is listening, permissions/state are installed, and hello succeeds for the current owner. `ensureDaemon` must wait for this readiness, not merely a PID record. Preserve concurrent-start owner election; do not add a second lock. On upgrade/restart, stale clients detect a new owner or broken transport, reread endpoint state, authenticate again, and reopen. Authentication failure produces no conversation side effects.

### Framing and messages

Use UTF-8 newline-delimited JSON, one object per line, with `protocolVersion:1`. Request IDs correlate responses within an authenticated connection; operation IDs correlate accepted mutations and later output. They are not durable message deduplication keys. Parse split/coalesced chunks correctly. Limit each physical frame to 1 MiB (1,048,576 bytes), including its JSON envelope and terminating newline, before unbounded accumulation; reject invalid UTF-8/JSON/shape/versions and close malformed connections. This is not a limit on a logical snapshot, pending proposal, display item, or cumulative bytes sent. These limits are implementation constants, not new user settings. Do not reject, truncate, or omit valid business content just because its logical size exceeds one frame.

`open` returns only attachment/read metadata. Explicit `snapshot` and snapshot delivery use the same metadata and item stream; none returns all arrays inline. The IPC adapter consumes §6's `AsyncIterable`, sending initial state first and then complete changed items or deletion keys. Every read is identified by transfer ID, conversation ID, captured revision, state sequence, operation ID (nullable), and snapshot mode (`initial` or `delta`). A response is emitted before that read's data. Use these transfer events (all carry `protocolVersion:1`, `type:'event'`, and `conversationId` in their outer envelope):

```typescript
type TransferEvent =
  | { kind: 'transfer_start'; transferId: string;
      purpose: 'snapshot' | 'output'; revision: number;
      stateSequence: number; operationId: string | null;
      mode?: SnapshotMode } // required for snapshots; absent for ordinary output
  | { kind: 'transfer_data'; transferId: string; itemIndex: number;
      fragmentIndex: number; finalFragment: boolean; data: string }
  | { kind: 'transfer_end'; transferId: string; itemCount: number }
  | { kind: 'transfer_error'; transferId: string; code: string };
```

For a snapshot, each item is one `SnapshotItem`; for ordinary delivery, the single item is a non-snapshot `PortOutput`. The service captures `OutputVersion` with its output and passes it to `deliver`; the adapter forwards it unchanged, never looking up a newer version when sending an old result. For snapshot delivery that version must match the read metadata. An output's operation ID identifies its originating operation, including a terminal transition to idle; a read's operation ID identifies running at capture or is null. `transfer_start` repeats and must match any read metadata in the response. Item indices and fragment indices start at zero and are contiguous. Serialize only the current item to JSON/UTF-8 bytes, split those bytes, and base64-encode each fragment independently. Start with at most 256 KiB raw bytes per fragment; measure the final envelope plus newline with `Buffer.byteLength` before writing and reduce the raw fragment if needed to fit 1 MiB. Reject an invalid envelope, never a valid item's size. Do not split by JavaScript string length or decode a partial UTF-8 code point. The receiver validates numbering/base64 and decodes each fragment to bytes, joins a complete item's bytes, then performs strict UTF-8 decoding, JSON parsing, and schema/identity validation before applying it. Thus even a single state/pending, inquiry, notice, or result larger than 1 MiB remains transferable.

Do not JSON-serialize a whole snapshot or precompute its fragments. Use one writer per socket for both control frames and data. Await the current write's completion callback, and `drain` when `socket.write` returned false, before producing the next fragment or pulling the next item. Keep at most the current serialized item and one candidate frame per transfer. Pending unsent socket output remains capped at 1 MiB, including already buffered bytes: wait for space before a write that would exceed the bound, rather than disconnecting merely because a large valid item needs several frames. A closed/failed or persistently stalled socket detaches that receiver and releases read resources; it does not abort the accepted daemon operation. Other attachments progress independently. Do not create an application output queue. Serialization/validation, current business-file reads, and receiver item assembly may require memory proportional to one item (or its containing goal file); the frame/output bounds are not a claim that total process memory is at most 1 MiB. The UI's retained logical display may also grow with its content.

Complete items may be applied incrementally, but only `transfer_end` with matching item count marks that read complete, including an empty delta with zero items. Missing/out-of-order fragments, validation/read errors, or `transfer_error` leave it incomplete and visibly require refresh; they never imply an empty or complete snapshot. On disconnect or cancellation, discard incomplete item bytes and release the iterator/current record/directory handles. Already complete authoritative state may remain displayed with incomplete status. Reconnect starts a new read/transfer ID; never resume partial bytes or automatically resubmit accepted operations.

| Direction / operation | Payload and behavior |
|---|---|
| request `hello` | Protocol version and capability; response identifies current daemon incarnation. Must precede all other requests. |
| request `open` | Required `params`: `conversationId`, `assignment`, `binding`, and `speaker` from the TUI port's `resolve` result. The server forwards all four to §6 `open`; the daemon compares the received ID with the expected ID for the current assignment before opening that record. Missing or mismatched IDs are rejected, not replaced. Return attachment ID plus read metadata (`transferId`, same validated `conversationId`, revision, stateSequence, operationId, mode), then start its item transfer; both TUIs get the same conversation ID. |
| request `snapshot` | Attachment ID; returns fresh read metadata, then transfers only changed state, assignment, goal, inquiry, display-event values and removed keys (or an initial read for a fresh attachment). Reads are permitted while busy. Superseding a read cancels/releases the old one instead of buffering another full read. |
| request `submit` | Attachment ID, request ID, speaker, and one §6 command; response is `accepted`, `busy`, or `error`. |
| message command | Current text, including the localized goal proposal request sent by `/make-goal`, even when a proposal is already displayed. This request generates or regenerates a proposal without registering a goal; it is not persisted. |
| approve/dismiss commands | Expected revision; never a client-supplied goal summary or ID to create. |
| answer command | Existing target/question ID, structured answer, and optional human-confirmed permission scope/sentence; preserve standalone inquiries and `answerSaved`. |
| goal-control commands | Pause/resume/abort goal ID; resolve repository through current assignment, retain task invalidation and auto-run behavior. |
| abort command | Current operation ID; explicit user cancellation. Refuse stale IDs; registration already committed is not rolled back. |
| request `detach` / transport close | Remove this attachment once and acknowledge when possible; no session close or turn abort. |
| output `reply`, `progress`, `result` | Conversation and operation IDs; transient replies/permission notices and terminal operation result, encoded as an output item through the same transfer events. |
| output `pending`, `running`, `snapshot` | Authoritative revision/pending/active state. An initial snapshot starts with complete state including approval receipt and interrupted flag; a delta may omit unchanged state. Ordinary pending/running use output transfers and the same version ordering. |
| output `notice`, `inquiry` | Stable domain IDs and saved content from existing files, transferred as complete output items even when large; no copies in the conversation store. |
| events `transfer_start`, `transfer_data`, `transfer_end`, `transfer_error` | §9 transfer events for snapshots and ordinary output; no all-snapshot inline alternative. Completion describes transport/read completion, not completion of a daemon mutation. |

The wire envelope uses `type:'request'` with `method` and `params`, `type:'response'` with the same `requestId` and `result` (or an explicit `error` object), and `type:'event'` with `conversationId` and a `TransferEvent` in `output`. For example, these are individual newline-terminated frames after open; the output item below is the UTF-8 JSON `{"kind":"progress","operationId":"X","message":"OK"}` encoded in base64. IDs are illustrative:

```jsonl
{"protocolVersion":1,"type":"request","requestId":"10","method":"submit","params":{"attachmentId":"A","speaker":{"namespace":"local","id":"operator"},"command":{"kind":"message","text":"Discuss a health command"}}}
{"protocolVersion":1,"type":"response","requestId":"10","result":{"kind":"accepted","operationId":"X"}}
{"protocolVersion":1,"type":"event","conversationId":"C","output":{"kind":"transfer_start","transferId":"T","purpose":"output","revision":5,"stateSequence":8,"operationId":"X"}}
{"protocolVersion":1,"type":"event","conversationId":"C","output":{"kind":"transfer_data","transferId":"T","itemIndex":0,"fragmentIndex":0,"finalFragment":true,"data":"eyJraW5kIjoicHJvZ3Jlc3MiLCJvcGVyYXRpb25JZCI6IlgiLCJtZXNzYWdlIjoiT0sifQ=="}}
{"protocolVersion":1,"type":"event","conversationId":"C","output":{"kind":"transfer_end","transferId":"T","itemCount":1}}
```

The server takes `requestId` from the envelope when calling §6 `submit`; no second independently supplied request ID is accepted in `params`. The IPC adapter owns one mapping from service failures to protocol error codes, including `stale_summary`, storage failure, invalid assignment, and unavailable attachment. Busy is a rejection, not acceptance. A stale-summary response/result starts a latest-state read through this same transfer mechanism; it never embeds a full snapshot in an error envelope.

Install the attachment and capture its state/sequence synchronously before asynchronous display reads. Send that read's metadata/start before later notifications, but do not delay all new state until its display scan ends. A receiver tracks active transfer IDs and the latest applied state sequence within the authenticated daemon incarnation. Apply a completely reconstructed state/pending/running item only if its sequence is not older and its revision/operation agrees with that authoritative state transition; late output from X must not clear running for a newer Y, even within one revision. A higher revision from a newer state supersedes the older pending. A completed revision-4 state or a delayed revision-4 fragment/end must never overwrite revision 5. `transfer_end` marks only that transfer's completeness: it does not reapply its captured state or clear running. Discard events from replaced/cancelled transfer IDs. On owner change reset ephemeral sequence tracking only after authenticating the new incarnation; do not reset durable revision checks.

Serialize items per socket; allow only one active snapshot read for an attachment. During a snapshot, pause its pull at item boundaries to deliver the latest changed conversation state before continuing display items. Hold only a dirty flag/latest authoritative sequence, not copies of every intervening pending/running notification, and obtain a fresh internally consistent state when writable. Such supersession is only for replaceable state: inquiry/notice content and accepted operation results must not be silently coalesced away. If a transient output cannot be delivered within bounded capacity, report delivery unavailable and detach as in §6; saved business content remains readable on reconnect. Never block daemon mutations on a slow display read or build an unbounded notification queue. Receivers merge complete display items by their stable domain ID, keep the existing ordering, and do not let the completion of an older read replace newer state or a newer read's collection.

Before each initial open, second-TUI open, or reconnect, the TUI adapter calls `resolve` for the selected assignment and sends its `conversationId`, `assignment`, `binding`, and `speaker` unchanged in IPC `open.params`. The server passes these to the common service check in §6; successful record selection and the returned snapshot use the resolved ID. An example logical exchange (hello omitted; R, T, and S denote the resolved assignment, binding, and speaker, and C denotes the resolved conversation ID):

```text
A -> resolve(repository /work/example) -> {conversationId: C, assignment: R, binding: T, speaker: S}
A -> open(conversationId C, assignment R, binding T, speaker S)
  <- attachment A, read metadata for C/revision 4/transfer T1
  <- start T1; fragmented complete state(pending 4, idle); display items; end T1
B -> resolve(same assignment) -> same C
B -> open(conversationId C, assignment R, binding T, speaker S)
  <- attachment B, read metadata for same C/revision 4/transfer T2
  <- start T2; fragmented complete state(same pending 4, idle); display items; end T2
A -> submit(message, request 10)
  <- accepted(operation X), after running/invalidation saved
B -> submit(message, request 11)
  <- busy(operation X); B's message will never run later
A -> disconnect
  daemon continues X, saves pending revision 5, clears running
B <- output transfers for pending revision 5, result X, idle
A'-> resolve(same assignment) -> same C
A'-> open(conversationId C, assignment R, binding T, speaker S)
  <- read metadata for same C/revision 5/new transfer T3
  <- start T3; fragmented complete state(pending 5); display items; end T3; no old transcript
B -> approve_summary(revision 4)
  <- accepted(operation Y), then stale_summary and fresh state/item read; no goal created
```

Structural validation may reject an obviously stale revision before acceptance; authoritative checks after any awaited membership resolution can still fail an accepted operation. In either case the terminal rejection has no registration side effect. An accepted request is owned by the daemon even if the acceptance frame is lost. After connection loss, do not automatically resend utterances, answers, permission appends, or goal controls. Reopen and inspect snapshot/domain state. A repeated approval is safe only through §4's same-revision reconciliation; this is not a general exactly-once IPC promise.

In B, keep TTY checks, editor/menu rendering, workspace selection, display sanitization, and explicit confirmations. Reconstruct the logical `ConversationSnapshot` from complete validated items, publishing display lists at transfer completion or failure; show incomplete/loading or read failure until the corresponding end, and clear partial item bytes on disconnect. Replace synchronous `getPendingSummary` reads with the latest fully reconstructed authoritative state plus revision checks; an incomplete pending fragment cannot enable approval. Remove TUI-owned provider preflight/session/MCP resources, `onNotification` callback transport, unmount/exit-to-turn-abort wiring, and message/operation queues. Ctrl+C detaches; Escape explicitly aborts a named turn when applicable. Use §6's daemon projection and item iterator so opening/refreshing inquiries and notifications does not depend on an all-record array or transcript history. Keep stable display IDs, ordering and notification policy; transport delivery does not delete or mark a domain inquiry answered. `notifications.ts`'s existing one-way Slack webhook is separate from a future interactive Slack port; preserve its current policy and avoid sending the same notice through both routes by accident.

## 10. Daemon lifetime

**Implemented files:** `src/features/daemon/runDaemon.ts`, IPC startup/shutdown, and `lifecycle.ts` own the conversation-related lifetime changes. `src/features/daemon/projects.ts`'s `hasDaemonProjectWork` remains focused on goals, inbox events, and pending/running tasks; it does not read conversation files.

The conversation service exposes current attachment count and active accepted/initializing operation count from daemon memory. Do not use saved binding/record/pending count as a reason to stay alive. Add these to the existing exit predicate:

```typescript
const idle = inFlight.size === 0
  && projects.every((cwd) => projectWork.get(cwd) === false)
  && conversationService.attachmentCount === 0
  && conversationService.activeOperationCount === 0;
```

Counts include record initialization/reservation writes and terminal cleanup, not just provider calls. Project state dirtied by an accepted domain operation must be reinspected before trusting a cached `projectWork=false`. When observing idle, synchronously mark shutdown admission closed before an await, then close the IPC listener. A connection/open already admitted holds a count; one racing after shutdown gets connection failure or an explicit shutting-down error and must explicitly reconnect through `ensureDaemon`. Do not accept work after deciding to exit.

In the same running daemon: zero project work plus one attached conversation keeps it alive; a second attachment and first detach still keep it alive; final detach during accepted X keeps it alive until X and cleanup finish; zero attachments, operations, project work, and project inspections then allow normal exit. Saved pending remains recoverable next startup but alone does not keep the daemon alive. These are `SCN-LIFE-P1` and `SCN-LIFE-N1`. An explicit `takt daemon stop` remains an intentional shutdown governed by §5, not an idle-lifetime violation.

## 11. Slack and Webhook applicability (SCN-PORT-P2)

**Future work:** there is no Slack/Webhook code or configuration in A/B. Later adapters would implement `ConversationPort` / `ConversationDelivery` and own their endpoint mapping/authentication. The conversation store remains unchanged for opaque bindings; changes to independent inquiry provenance or multi-conversation selection require separate future work.

### Concrete mapping through the proposed interface

For a future Slack adapter, `Endpoint` contains authenticated team ID, channel ID, parent message timestamp, and the acting user ID. Use `binding.port='slack'`, `binding.key=JSON.stringify([teamId, channelId, parentTs])`, `binding.counterpart={namespace:'slack-thread', id:binding.key}`, and `speaker={namespace:'slack-user', id:JSON.stringify([teamId,userId])}`. Preserve timestamps as strings. The adapter associates this endpoint key with an authorized repository/workspace assignment and derives C using §2. A reply in the thread resolves the same key/C; a different speaker in the same authorized thread changes the speaker, not the conversation ID. The record's logical counterpart can remain the shared assignment audience while each binding names its endpoint audience.

Ingress obtains `resolved` from the Slack port's `resolve(endpoint)`, then calls `input.open({ conversationId: resolved.conversationId, assignment: resolved.assignment, binding: resolved.binding, speaker: resolved.speaker }, port.delivery)`. The common service check in §6 compares that ID with the expected ID for the current authorized assignment before opening the record and returning the same ID in its item read; changing only the submitted ID to a mismatch rejects the open. The adapter consumes that read incrementally; the reconstructed state/snapshot has the same validated ID. It then uses `input.submit` with text or structured answer. Buttons carry conversation ID, expected revision or question ID, and an opaque action identifier validated by the adapter; they do not carry authoritative replacement summaries. Delivery uses the binding to post into that thread. An attachment represents a live adapter subscription, not the lifetime of a Slack HTTP request. `resolve` checks the configured endpoint/assignment access relation before selecting C; possession of thread IDs alone is not permission.

For a future Webhook adapter, use an authenticated principal P and adapter-owned endpoint key E: `binding.port='webhook'`, `key=JSON.stringify([P,E])`, `counterpart={namespace:'webhook-peer', id:key}`, and speaker from the verified principal/actor mapping. Adapter mapping `(P,E) -> authorized assignment -> C` separates peer identity from a reply destination. After authentication and assignment authorization, the Webhook port's `resolve(endpoint)` supplies `resolved`; ingress calls `input.open({ conversationId: resolved.conversationId, assignment: resolved.assignment, binding: resolved.binding, speaker: resolved.speaker }, port.delivery)` before using the returned attachment for submit. The §6 check rejects a missing ID or an ID that differs from the current assignment's expected ID before record access, and a successful snapshot contains that same validated ID. An arbitrary ID in the HTTP body never overrides the authenticated mapping's resolved ID. An allowed callback registration or a separately authenticated status read supplies the return path. Callback URLs/tokens belong to that future adapter's private storage, not the opaque binding or conversation record. The local IPC capability is not Webhook authentication.

The Webhook adapter likewise consumes the returned item read, preserving the validated ID when reconstructing state for an authenticated status read or callback. The common pull-based read does not impose the local IPC frame format on Slack/HTTP. Their future delivery adapters must map complete items to their transport's size/rate limits explicitly and report unavailable if they cannot deliver; this note supplies no new external delivery guarantee, settings, or implementation.

The following decisions deliberately separate what fits the current service shape from what requires future adapter or selection work. They are design conclusions, not implemented Slack/HTTP behavior.

| Case | Fit in this design | Limitation and future action |
|---|---|---|
| Slack thread `(team, channel, parent ts)` | Fits: one opaque binding key resolves to one C; counterpart and speaker are separate. | Slack request verification, authorized assignment association, and thread delivery must be implemented in the future adapter. No Slack key parsing in storage. |
| Channel-level message outside a thread | Does not directly fit a thread binding: there is no chosen parent conversation endpoint. | Future adapter explicitly creates/selects a parent and guides the user into its thread, or rejects with instructions. Do not silently treat a whole channel as one conversation. |
| Several threads for one assignment | Fits the selected one-current-conversation-per-assignment policy: each binding maps to the same C. | They share provider context and pending proposal. Do not broadcast private content into a thread with a different audience. Future adapter must authorize a common audience and route output appropriately; otherwise reject that association. Independent private thread contexts do not fit this ID policy and require a future change to selection (endpoint-scoped conversation identity), not a store `switch` or a hidden session per port. |
| Slack button acknowledgment versus AI latency | Service admission and completion are already separate, so asynchronous completion fits. | The future Slack transport must acknowledge valid interactions within 3 seconds, independently of AI completion, then deliver accepted/busy/error and final results separately. ACK is not daemon acceptance. Slow disk/provider work cannot be placed on the ACK path. Long-lived delivery cannot assume a short-lived response URL remains valid. [Slack interaction specification](https://docs.slack.dev/interactivity/handling-user-interaction/) |
| Same person sends from TUI and Slack simultaneously | Fits: both resolve C, and §8 returns busy for the later mutation even if speaker identities are linked. | Show busy at the rejected source (TUI status/message or Slack action response) with no queue or automatic resubmission. Actor identity matching is not used to merge or deduplicate utterances. |
| Slack displays revision 4 while TUI has revision 5 | Fits: approval includes C and revision, and the daemon checks current pending. | Reject 4 with stale_summary, leave 5 unchanged, and refresh the Slack proposal/buttons. Updating an old Slack display is a future delivery concern; stale controls never regain authority. A duplicate already registered approval returns its receipt without creating a goal. |
| Webhook peer identity | Fits as namespaced principal/endpoint binding and distinct speaker. | An arbitrary body field cannot establish P. Future authentication/assignment authorization must reject spoofed peers and conversation IDs before service submission. Multi-tenant isolation is not supplied by local IPC. |
| Webhook reply destination | A stable adapter-owned callback/subscription can implement delivery. | An incoming request with no return mechanism cannot receive a later reply merely because it submitted text. Future adapter must choose callback or authenticated status retrieval and define how it remains attached while serving that peer. No callback URL from untrusted text is fetched automatically. |
| Webhook authentication and permission scope | Adapter authentication followed by service target/scope validation fits the boundary. | HTTPS ingress, signature/token verification, replay protection, callback allowlisting, and principal-to-assignment policy need a future HTTP design. The human-confirmed permission append operation must not become callable by any unauthenticated sender. No such settings or HTTP server are added here. |
| Peer cannot receive replies/notices/inquiries | Delivery returns unavailable; durable domain state remains readable. This failure is representable. | Reliable notification delivery does not fit the current best-effort interface. Keep notifications/inquiries in their existing files for another authorized port; never claim delivered or auto-answer. A future requirement for delivery receipts/retries/offline replay needs separate design. Do not store conversation text in an outbox now. |
| HTTP/Slack retries and duplicate delivery | Same-revision summary approval can reuse its goal receipt. | General message/answer retries are not idempotent through request ID alone. Future adapter must specify external event identity/deduplication before enabling automatic transport retry; no request queue is added to the conversation service. |
| Webhook inquiry answer provenance | Port input can represent the answer, target, and authenticated speaker. | Current `GoalAnswerSchema.source` accepts only `tui` and `slack`; Webhook cannot truthfully persist its source unchanged. A future Webhook implementation must extend the inquiry answer producer/schema/consumers together. A/B keep TUI provenance; never label Webhook answers as TUI to bypass validation. |
| Long-lived external subscriptions and idle exit | Fits if a live future adapter subscription counts as an attachment in §10. | A stored Slack thread/Webhook binding is not an active subscription. The future adapter must define attach/detach and wakeup/host ownership; storing a binding alone cannot keep this daemon resident forever. |

The decisive limit is that the common interface models input and live delivery; it does not supply Slack interaction acknowledgment, HTTP trust, independent per-thread provider history, or durable outbound delivery. Those responsibilities remain explicit future work. The existing `notifications.ts` Slack webhook only sends saved notifications in one direction; it cannot stand in for this interactive thread adapter.

## 12. Implementation stages and verification

The table below records the original scope and outcomes of the implemented A/B/C stages. New internal filenames in it describe implementation structure, not additional public API requirements. Keep infrastructure schemas below features and compose adapters at daemon/manager entrypoints; do not export infrastructure implementations from the package's public API.

| Stage | Files introduced or changed | Observable result and boundary |
|---|---|---|
| A: storage, daemon service, IPC, lifetime | Added `src/infra/conversations/{schema,store,identity}.ts`, `src/infra/daemon/ipcEndpoint.ts`, `src/features/manager/{conversationService,conversationPort,turnExecutor}.ts`, and `src/features/daemon/conversationIpcServer.ts`. Changed `conversationSession.ts` to delegate provider execution, `runEventManager.ts`, `runDaemon.ts`, `lifecycle.ts`, owner readiness/private IPC state, and the narrow goal registration boundary in `src/infra/goals/{service,git,store}.ts` as needed by §4. Added sequential reads in goals `store.ts`, `standalone-inquiries.ts`, `pending-inquiries.ts` and the `savedEvents.ts` projection, preserving their validation, ordering and policy (§6). | A real local client can open/submit/reconnect without Ink and consume complete large state/display items through bounded physical frames. Daemon alone owns conversation files. The TUI migration in B removed the temporary local session facade and made the human path daemon-only. |
| B: first port, TUI client | Added `src/features/manager/{conversationIpcClient,tuiConversationPort}.ts` with incremental item reassembly, transfer validation/cancellation and revision/sequence ordering. Changed `runManager.tsx`, `ManagerView.tsx`, `useManagerInput.ts`, `useManagerSummaryApproval.ts`, and answer-hook wiring as necessary. Removed unused queue display and replaced direct-session exports after checking references. | `takt manager` is an IPC client. Ctrl+C disconnects, accepted work continues, two TUIs share C and complete pending; no client mutates conversation state files or calls the manager provider directly. Goal/inquiry UI validation and confirmation semantics, display IDs/order, incomplete-read indication and rejection of partial/stale state remain. |
| C: user documentation | Updated `README.md`, `docs/README.ja.md`, and `docs/README.zh-CN.md`. | Documents daemon ownership, reconnection without transcript restore, busy rejection, storage/privacy, config-directory scope, supported OS transport, and explicit stop. It does not claim Slack/Webhook is implemented. |

A can be exercised independently of B using a fake provider, in-memory delivery adapter, isolated config directory/repositories, and real `node:net` clients. The paths below identify existing implementation tests and planned coverage; use repository runner classification for any future tests.

| Test suite / planned coverage | Direct observations required in A |
|---|---|
| `conversation-store.integration.test.ts` | Round-trip the allowlisted record, revision, reserved ID and session. Verify no utterance/reply/history fields are persisted. Reject malformed/version-mismatched/identity-mismatched records. Inject temp-write/rename failure and observe the prior complete JSON unchanged. |
| `manager-conversation-service.integration.test.ts` | Same canonical assignment across open/reopen/two attachments selects one C and pending. Revision 4 then new message/pending 5 rejects approval 4 with zero goal calls. Reserve ID, inject stops around goal creation, retry the same approval and observe one existing goal/unchanged ID; unreadable goal never becomes absence. Include ambiguous branch/event diagnostics from §4. |
| `manager-conversation-service.integration.test.ts` (session cases) | Expired session starts fresh with the captured proposal plus current goals. Tool-used failure is not replayed. Preserve one overflow retry and cleanup. Assert actual executor inputs/session IDs, not only absence of an error phrase. |
| `daemon-conversation-ipc.integration.test.ts` | In one live daemon accept X, disconnect its TUI while fake provider remains running, finish X, reconnect to C and observe its saved pending. With two real clients, later message receives busy before first completes and never invokes provider afterwards. Cover split frames, invalid input/authentication, bounded output, and snapshot/notification ordering. |
| `manager-conversation-sequential-reads.integration.test.ts` | Pull state before display items and compare C, revision 4, full pending, approval and running as one captured state. Instrument storage reads to prove the next payload is not read before demand and no all-record list/slice path runs. Preserve owner/assignment/status validation, corruption diagnostics, display IDs/order and notification policy. Independently compare all IDs and complete content for goal lists and individual pending/inquiries using the size cases below. |
| `daemon-conversation-ipc.integration.test.ts` (large transfer cases) | Through real clients test open, explicit snapshot, second TUI, reconnect, snapshot delivery and ordinary pending/inquiry/notice/result delivery. Vary total snapshot size separately from one item's size. Compare C, revision, every ID, full strings and every array element after reassembly; measure every envelope plus newline at no more than 1,048,576 bytes. Assert demand stops at socket backpressure and pending unsent bytes stay bounded without dropping items. In the same connection/read, delay revision-4 fragments/end while a revision-5 update arrives: pending 5 and newer running must survive. Also test a running change within the same revision, superseded transfer IDs, invalid/missing fragments, read failure and disconnect mid-item; incomplete data is never marked complete, read resources close, and a fresh reconnect restores all content without replaying X. |
| `manager-conversation-ipc-client.test.ts`, `manager-conversation-transfer.test.ts`, and `it-goal-mcp-stdio.test.ts` | Reassemble the large goal, pending, goal-inquiry fixtures below and ordinary output notices, and separately the ordinary standalone permission approval described below; render their complete content with stable IDs/order and the appropriate inquiry target/owner. On the same mounted screen, receive revision 4, then 5 during a read, then delayed 4/end; retain 5. Disconnect midway through an item, show incomplete state, reconnect to the same C and restore full pending; partial pending never enables approval. |
| `manager-conversation-service.integration.test.ts` and `daemon-run.test.ts` | Reload a record from owner PID/start A under B (including reused PID/different start); observe interrupted snapshot, cleared running/session, preserved pending/reserved ID, and successful new admission. Do not replay missing message text. A matching owner without a live operation is not left permanently busy. |
| `conversationSession.test.ts`, `manager-conversation-service.integration.test.ts`, and `daemon-conversation-events.integration.test.ts` | On the same loaded human conversation, create pending 4, run an event through the shared executor, then approve 4. Observe unchanged human session/pending/revision throughout; event starts without a session and cannot return a registration proposal. Preserve event timeout, failure retention, patrol, work log, permission/MCP cleanup. |
| `daemon-run.test.ts` and `daemon-lifecycle.test.ts` | On the same daemon instance observe no project work -> attach -> second attach -> detach first -> accept X -> detach last -> finish X. Exit only after X/cleanup and reinspection of any new domain work. Persisted pending without attachments/work does not keep it alive. Cover open racing with idle shutdown. |
| Inquiry/answer tests covering service and existing stores | Goal and standalone answers check assignment/owner and preserve structured decisions/reports. Permission append is validated data, not a callback; failures preserve truthful `answerSaved` and partial append status without automatic replay. |

For the future large-data cases, hold C, assignment, revision 4, owner/notification policy and other small display data fixed. Use nonempty ASCII strings of 128 KiB: compare 7 versus 9 goals with that objective; a single pending with 7 versus 9 constraints; a goal inquiry created through `takt_ask_goal_question` with 7 versus 9 such options; and an ordinary output notice with a body of 7 versus 9 such units. Nine units alone are 1,179,648 bytes before JSON overhead, above one frame. Preserve the current business schemas: no new count/text cap, larger physical frame, truncated field or omitted item is an acceptable fix. Goal totals and single-item totals must be distinct tests. Observe actual IDs/full content/revision and physical frame sizes, not merely counts or the absence of errors. These are requirements for A/B's tests, not evidence of an implementation in this note.

For standalone coverage in A/B, use an ordinary goal-less permission request produced by `saveManagerToolPermissionInquiry` in `src/features/manager/toolPermissionInquiry.ts`: `kind:'approval'`, body, operation and permissionProposal, with no added options. Follow `getOrCreateApproval` into the resolved owner's storage, pending reads, item transfer, display and answer validation. Compare the saved ID, body, operation, permissionProposal and owner at the display boundary (`goalId:null` with the matching owner), retain assignment/owner authorization, and verify that withdrawing that same inquiry removes it from pending display on refresh. The current standalone producer does not supply options; schema acceptance or constructing a value through a generic store method does not establish a product input path. Do not apply the goal inquiry's large-options fixture to standalone inquiries or replace it with another unsupported large input. This fixture choice does not narrow the shared schema, store API or supported inquiry kinds.

Run the appropriate whole-file test through `npm test -- <file>` in those implementation stages, and the classification wiring check when an integration test is added/changed. Use both Unix socket and Windows pipe runs for endpoint/permission evidence; Unix-only simulation cannot prove Windows ACL or pipe behavior. A/B's changed runtime also requires the repository build, lint, unit/light integration gates and focused mock E2E smoke gate. No broad heavy-IT/E2E run or final-confirmation task is introduced by this note; the manager owns the goal's single final confirmation.

This note is an architecture record for the implemented local conversation path and the remaining adapter boundaries. The detailed contracts in §§1–11 describe the intended behavior; use the referenced source and tests as evidence for what the current implementation actually does. User-facing usage details are maintained in the README and translated documentation.
