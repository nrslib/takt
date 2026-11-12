# Daemon conversation ports

This is the event-driven conversation contract. The event and process contracts in `src/core/daemon/` are the source of truth. `runDaemon.ts` が dispatcher、会話状態、ターン子、IPC、Slack、watcher を結線し、CLI は専用 daemon プロセスへ接続する。

## Ownership and execution

The daemon owns admission, two durable queues, conversation state, snapshots, delivery routes, and lightweight watchers. It never runs business preparation, AI, MCP tools, task execution, or synchronous business-store scans. Each conversation has one persistent child process for those operations. Human input and event turns share that conversation and provider session.

セッションには system prompt・provider・model・実行設定と担当を含む fingerprint を `contextKey` として保存する。初回の再開を含め、保存値と現在の値が異なれば session ID を破棄して開始する。fingerprint のない旧状態は既存の provider/model の比較でセッションを引き継ぎ、現在の fingerprint を保存して以後の変更を検出する。旧状態の保存前に起きた system prompt の変更は判別できない。セッションを使わない patrol はこの値を更新しない。

There are exactly two model queues: human input (including inquiry answers) and other events (including director messages and patrols). At the next turn boundary, human input has priority, followed by ordinary events, then patrols. Within the other queue, waiting ordinary events take precedence over patrols, including while persistence or a conversation slot is pending. Acceptance order is preserved within each conversation's human input, ordinary events and patrols. After human input is durably accepted, a running patrol in the same conversation is interrupted; other running turns are not preempted. Interrupt targets its operation ID and generation and never removes queued input. A patrol interrupted by human input or an explicit interrupt is settled without requeueing; the next scheduled interval can enqueue a new patrol. A patrol interrupted by daemon shutdown or restart is redelivered on the next startup. Patrols deliver only their completed result to the TUI, without intermediate output.

Watchers use asynchronous, bounded observations. They emit events for changes and anomalies, without calling a model themselves. Separately, manager patrols enqueue one turn per repository at the configured interval (30 minutes by default), only while active goals exist. Patrols use the other lane, never accumulate within a conversation, and do not replay missed intervals. Director patrols remain disabled. Failed turns are not blindly replayed; manager inspects current state and side effects to decide recovery. Retrying a failed persistence operation reuses the stored result and never reruns AI.

## Admission and control

`createDaemonConversationInput` adapts the TUI and Slack `ConversationInput` to `DaemonIngress`. Assignment resolution uses registered routing data supplied by composition, not goal/task stores or provider configuration. Client-side repository normalization connects repositories in a workspace to the same conversation.

An attachment fixes its authenticated speaker, assignment, port binding, and optional CLI provider/model overrides. Each human event carries those overrides. Changing the speaker through a later submit is rejected. Director accepts only conversation messages. Inquiry answers retain their target, question ID, and source; the child validates the target and current question state. New admissions reject the legacy `permission` field, and loading saved records strips it.

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

Manager and director channels may be shared. A bound inquiry thread routes only to its manager and uses that manager's allowlist; other speech in a director channel routes to director. Goal registration buttons carry conversation ID and revision. Question answers and operation reports retain their Slack origin. Permission modals are no longer supported.

Inquiry changes arrive through `delivery.deliver` from watchers or the state owner. Slack performs no initial or five-second whole-inquiry scan. The posted inquiry uses the delivered question; answering a bound thread reads its current question through the snapshot interface, and the child revalidates it on execution. Binding reads and writes are asynchronous. An unreadable binding fails closed, rather than treating the answer as ordinary conversation. Existing inquiries remain accessible through the TUI.

要求と送信元スレッドの対応は稼働中のポートがメモリに保持する。daemon の再起動後、この対応は復元されない。イベントの永続受付と、再起動後の Slack 配送先の復元は別の保証である。

## Child state requests and director delivery

A child uses the finite `DaemonBus.request` protocol. `tellDirectorManager` submits `accept_director_message` with the current `TurnIdentity`, event/request IDs, target conversation, timestamp, and text. It waits only for durable admission, never for the manager reply, and never reconnects to its own daemon through IPC.

The dispatcher validates active turn, operation, generation, cancellation, and shutdown. The state owner checks authorization and assignment scope. The target manager receives `director_message` on the other-event queue. A director message is not a human merge instruction unless the original human explicitly authorized that merge. 新規の `takt_tell_manager` は `origin: director | human` を必須とし、director 自身の依頼と人から受け取った指示の中継を分ける。受け箱・イベント保存・IPC・manager の入力まで同じ値を運ぶ。旧保存イベントの省略値は発信元不明として扱い、本文から人の意思を推測しない。構造化された人の回答と、producer を識別できる旧回答イベントの正規化は別に維持する。

`connectedPorts` supplies delivery metadata for `get_delivery`. 状態所有者は `notify_director` を永続保存し、通知 ID で重複を除いて画面へ配信する。Slack への通知は director ターンの結果にまとめて配信する。 Delivery success is not inferred from notification persistence. Replies, failures, and interruptions retain their operation ID. An accepted director message is not automatically resent after failure or disconnection.

## Approval and recovery

Proposal revision and conversation-state version are separate. The child reserves an approval before external side effects through a conditional `save_conversation` request. A reservation fixes the revision, repository, and generated goal ID. Repeated requests with the same operation ID must be idempotent; changed content or an unexpected state version is rejected.

登録イベントを受け箱から移送した後も、`daemon-events` の受付記録が既存ゴールの登録の証拠となる。承認が reserved のまま子が終了した場合、再承認は同じ goalId を使って回復する。 An unresolved reservation prevents overwriting its input. A crash after an external side effect requires reconciliation of saved facts, never blind repetition.

ゴールの状態操作は入口で `origin: human | manager` を決め、再開時の `resumed` 受け箱イベントから `goal_resumed`、保存、IPC、manager の入力へ伝える。人の直接操作だけが `human`、manager の MCP 操作は `manager` となる。旧受け箱・保存イベントに発信元がなければ不明として読み、人の指示とは扱わない。

Event persistence follows accept → started → result → settled. On restart, queued events retain their order. Non-human events interrupted by daemon shutdown, or found running during restore, return through the existing deferred → queued path and are redelivered with their original IDs and acceptance order. Human input retains its existing interruption behavior, including interruptedMessage for messages. Explicitly interrupted turns remain settled, even if shutdown follows the interrupt. Settling events apply their already-saved result; a deferred result returns its event to the queue before delivery. No retry count limit is imposed. Stale child launch IDs, operation IDs, and generations cannot update conversation state. 保存確定後・応答前の停止で中断結果の版が古くなった場合、中断の後片付けだけを最新の版へ載せ直す。通常の保存と完了結果では版の一致を要求する。

## 現在の結線と制約

`runDaemon.ts` は `createDaemonConversationInput` を dispatcher と非同期の会話状態所有者へ接続する。watcher の問い合わせ変更は会話配送を通して TUI と Slack へ届く。Slack ポートには解決済みの設定を渡す。子の director 要求は dispatcher と状態所有者が認可し、イベント受付・通知保存・接続ポートの照会を処理する。旧 daemon のゴール単位の巡回と自己 IPC の呼び出し経路は廃止され、manager の定期的な見回りはリポジトリ単位で other キューへ入る。daemon から到達する同期 API は lint で常時禁止されている。

run 消失の観測は子で状態を再確認し、現在の実行ならタスクを修復して completion を受け箱へ保存する。古い観測は処理済みとして終える。AI が扱うのは後続の task_completed / task_failed のみで、消失の観測では呼ばない。開始時刻が不明でも PID は保持し、不存在が確かめられた場合だけ消失と扱う。存在する PID の本人確認ができなければ unknown を維持する。director はゴール状態・未回答質問・blocked 通知 ID の変化を観測し、同じ保存済み通知では再起動後もイベントを増やさない。

`tasks.yaml` とゴール JSON は非同期で読み込むが、解析は親 daemon で行う。大きなファイルの解析をワーカーへ移す仕様項目は未対応である。Slack の要求とスレッドの対応も再起動をまたいで永続化されない。
