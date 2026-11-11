# Managing goals with manager

`takt manager` is an experimental TUI for discussing goals and coordinating work. Manager and task execution incur provider costs.

## Manager patrols

Each patrol runs in a new session, separate from the conversation, and does not read the conversation history. The initial prompt includes the business context it needs. Results remain in work records and are available to later conversation turns through that context. Human conversations continue in their original session.

For each repository with active goals (excluding paused, aborted, completed and human merge waits), the manager periodically inspects eligible goals together. No patrol runs when there are no eligible goals. Set `manager.patrol_interval` to a positive integer in seconds in `.takt/config.yaml` or `~/.takt/config.yaml`. Repository settings take precedence; the default is 1800 seconds (30 minutes).

A goal is waiting for human merge when it is `awaiting_merge`, none of its linked finishing tasks (`merge_task: true`) are `pending` or `running`, and its last finishing task is not `failed`, `exceeded` or `pr_failed`. The last task is determined by its position in `tasks.yaml`. A goal with no finishing tasks also waits for human merge. Goals with pending or running finishing work, or whose last finishing task failed, remain eligible for patrols.

The daemon saves the last accepted patrol time for each repository. On startup, it queues one patrol at the first observation if eligible goals exist and either the interval has elapsed or no patrol has been accepted before. Otherwise, it waits until the last accepted patrol time plus the interval. Restarting the daemon repeatedly does not add patrols before that interval has elapsed.

Goals awaiting merge (`awaiting_merge`) are monitored by the PR watcher. In addition to merges and closures, it delivers conflicts with the integration target (`mergeable: CONFLICTING`) as events to the manager. It does not repeat a conflict while it persists; after it resolves, a recurrence is reported again. `mergeable: UNKNOWN` is not counted as a change. Time and counts do not determine anomalies. The manager checks current state and existing tasks, then enqueues preparation with `takt_merge_goal_pr` when needed. The default `approve` mode uses `until: prepare` and waits for human merge.

```yaml
manager:
  patrol_interval: 1800
```

Patrols enter the non-human event queue. Processing priority is human input, ordinary events, then patrols; a patrol starts only when neither of the first two has waiting input. Accepting human input from the TUI or Slack in the same conversation interrupts a running patrol so the human input can be processed first. A patrol interrupted by human input or an explicit interrupt is not retried; patrols resume at the next interval. A patrol interrupted by daemon shutdown or restart is redelivered on the next startup. Queued input and events remain intact. Human input does not interrupt other running turns. Pending or running patrols do not accumulate, and missed intervals while the daemon is stopped are not replayed. While the TUI is connected, it displays one short result from a completed patrol, such as “Patrol: 2 goals, no anomalies”, without intermediate output. Details remain in work records. Inspection records alone do not count as progress. No Slack or other notification is sent when nothing is wrong. The manager uses existing notification or inquiry tools when a problem requires attention.

Patrols compare the latest reports and records from running runs against the task instructions and acceptance criteria to check for deviations from the requested work. Threats or assumptions beyond the target scope, impossible premises, requirements absent from the acceptance criteria and unnecessary machinery are reported to the run with supporting evidence. Execution time and step counts do not determine anomalies. The `run_launch_stalled` observation remains to report a TAKT failure when a pending task has not started after 30 seconds. Director patrols remain disabled; the legacy `director.patrol_interval` setting is read and ignored.

## Discussion and registration

While a turn is running, the TUI shows its elapsed time and current activity. Bash displays its description when available; other tools display their names. Long tool labels end with an ellipsis so elapsed time remains visible at 80 columns. In ordinary turns and the interpretation stage of `/verify`, intermediate text appears in the conversation in order when the next tool starts, before the final reply. Text remaining at the end of the turn or interpretation stage is discarded without being shown as intermediate output. The final reply is still displayed. This intermediate text is not saved or redisplayed after reconnecting. Patrol turns show tool activity and elapsed time but omit intermediate text. Slack does not receive intermediate text or tool descriptions.

Start `takt manager` in an interactive terminal and describe the objective, scope exclusions, acceptance criteria and work constraints. Manager starts the daemon if needed and waits until it is ready; the TUI connects to it to send requests and display results. Type `/make-goal` in the input box and press `Enter` to create a goal proposal from the conversation. Review the displayed proposal and use `↑↓` to choose **Register goal** or **Return to conversation without registering**, then press `Enter`. The default returns to the conversation and dismisses the proposal. Select **Register goal** to ask the daemon to register it. Returning to the conversation, pressing `Esc` while idle, or typing changes dismisses the proposal; ask manager for changes and generate a new proposal. During processing, `Esc` interrupts the operation.

Even when a proposal is already displayed, `/make-goal` only regenerates it from the current conversation; it does not register the goal. Registration requires selecting **Register goal** and pressing `Enter`. If there is insufficient material, manager explains this and you can continue the conversation. Manager can also offer a goal proposal itself.

The bottom status line shows the assignment name, counts of ongoing goals (active and paused), human merge waits and unanswered inquiries. Goals with pending or running finishing work, or whose last finishing task failed, count as ongoing. Long assignment headings are truncated in the middle to preserve the counts; narrow terminals show the assignment and counts on two lines. The experimental notice appears once in yellow at the start of the transcript each time the TUI opens. It does not list completed or aborted goals or inquiry bodies. Typing `/` in the input box offers `/make-goal` and `/verify` as completion candidates; use `↑↓` to choose one and `Tab` to accept it. Input starting with `/` other than `/make-goal` and `/verify` is sent to manager as a regular message.

Below the input box, key hints are followed by the status line (example below). The `/make-goal` and `/verify` explanations appear in slash completion rather than as permanent hints. The full experimental notice appears once at startup.

```text
Enter Send  Shift+Enter Newline  Esc Interrupt  ^R Inquiries  ^G Goals  ^C Exit
Assignment: takt | Ongoing 1 / Pending 0
```

The daemon owns and runs manager conversations. Once a turn is accepted, closing the TUI only disconnects that screen; the turn continues in the daemon. Reopening manager for the same repository or workspace, or opening a second TUI for that assignment, connects to the same conversation. A pending goal proposal is shown again and can be registered by selecting **Register goal** and pressing `Enter`, but previous messages and replies are not redisplayed. Conversation history is managed by the provider's session. TAKT saves waiting message text until execution starts. Pending summaries and goal records are saved separately.

The daemon is event driven. It has two queues: human input and other events. Human input takes priority when starting the next turn. Within the other queue, patrols wait behind ordinary events; acceptance order is preserved among human inputs, among ordinary events and among patrols. Turns other than patrols share one conversation session, retaining context learned from events for later human messages. Messages, approvals, and inquiry answers can be accepted and saved while a turn is running; snapshot reads and interruption remain available. accepted means durable admission, not completion. Interrupting the active turn preserves waiting input. Failed turns are not blindly replayed; manager inspects current state and side effects to decide recovery.

Non-human events interrupted by daemon shutdown, or found still `running` at startup, return to their original queue positions and are redelivered. This includes task results, PR changes, patrols, and director messages. Human-input priority and the lower priority of patrols remain unchanged. Turns explicitly interrupted by the human stay settled and are not redelivered. Interrupted human messages retain the existing `interruptedMessage` behavior for the next message.

After registration, the manager inside the daemon handles events, submits tasks, checks and integrates results, and selects next work. The TUI displays notifications and lets you continue the conversation with a manager that receives those events. Work records are not displayed in the TUI. Closing the TUI also leaves an already running run active.

By default, required runs start automatically. Disable this to start `takt run` / `takt watch` yourself.

```yaml
manager:
  auto_run: false
```

Set `manager.workflows` in global `~/.takt/config.yaml` or project `.takt/config.yaml` to choose the workflows manager may use for new development tasks. A project value replaces the entire global list. Each entry is a name or a single `{ name: usage description }` pair, using the same notation as `workflow_categories.workflows`.

```yaml
manager:
  workflows:
    - default: Regular features and bug fixes, covering planning through review.
    - simple: Small changes in one or two files, using a lightweight workflow.
    - takt-default
```

When `manager.workflows` is omitted at both project and global scopes, the candidates are `default` and `simple`. Manager receives the usage descriptions above in English or their Japanese equivalents according to `language` and selects a workflow suited to the task. Explicit name-only entries have no usage description. Set `workflows: all` to allow all workflows, as before. Missing workflow names produce a warning when the manager conversation plan is created and are ignored; malformed entries, including blank names or objects with multiple keys, are rejected when configuration is loaded.

Manager's `takt_list_workflows` returns only allowed candidates, with the workflow's own `description` and an optional configured `usageDescription`. New submissions through `takt_enqueue_goal_task` are rejected by the tool if the workflow is outside this selection; the error lists allowed candidates and configuration paths. Existing tasks can still resume, requeue or retry with their saved workflow. PR finishing through `takt_merge_goal_pr` (`merge.workflow` or `merge-prepare`) is outside this restriction, as are child `workflow_call` targets, non-manager MCP servers and manual CLI use. Workspace managers apply each assigned repository's selection when listing or submitting its tasks.

Manager supports Claude, Codex and OpenCode. Its tools use existing TAKT features for submission, requeue, retry, removal, run inspection, diffs, history, integration and completion checks. Before acting, it checks tasks, run records and reports, and git, without repeating finished actions.

Use these tools for inquiries that do not belong to a goal.

| Tool | Purpose |
|------|---------|
| `takt_list_standalone_inquiries` | Read unanswered inquiries without a goal saved under the current assignment, including their id, kind, body and creation time. |
| `takt_withdraw_standalone_inquiry` | Withdraw an unanswered inquiry without a goal by passing its id and a reason. An inquiry that is no longer unanswered keeps both its state and saved answer unchanged. |

Every turn, manager reviews unanswered inquiries both with and without a goal. It withdraws inquiries that no longer matter, such as approval for an operation that is no longer running, with a reason and records that reason in work records. It keeps inquiries that still need a human decision.

Manager is an engineer familiar with TAKT, responsible for completing assigned goals. It investigates, implements, verifies, performs Git operations and delegates when useful. It uses normal provider tools and assigned MCP servers with `full` permissions, preserving configured provider options. There is no manager-specific permission judge, read-scope review or execution control based on saved approvals.

Facet policy requires explicit human instructions identifying the target and effect for integration into a target branch, force pushes, deletion of remote branches or unsaved results, goal aborts and new posts outside the requested scope. Direct messages, director relays and saved continuing instructions are supported. PR creation, ordinary pushes and configured notifications are part of requested work. Instructions already given are not reconfirmed. The goal branch is kept after its PR is merged for subsequent checks and work. Reading secret values requires a human instruction covering that need, and secret values must not appear in responses, records or artifacts.

Legacy `manager.sensitive_paths` and runtime `provider.targets.internal_agents.manager-permission-judge` are deprecated. Existing configuration files remain readable, but these settings are ignored and have no effect. Old permission Markdown and approval answers do not decide execution. Historical inquiry records remain readable and withdrawable.

Assign user MCP servers through the existing `runtime.yaml` rules. For example, to assign a browser MCP server you have installed:

```yaml
version: 1
mcp:
  servers:
    browser:
      type: stdio
      command: /absolute/path/to/browser-mcp-server
  targets:
    personas:
      manager:
        servers: [browser]
```

Replace `command` with your server executable. No browser MCP server is bundled or enabled by default. Manager receives `defaults.servers` and its persona assignments, with persona exclusions and `internal_agents.selector.exclude` applied. Its own TAKT MCP server is always added and takes precedence over a user server with the same name.

## Events and watchers

Code watchers observe process loss and PR state changes and emit events only for changes or anomalies. Manager patrols run once per repository at the interval described above. Director is never called by a clock. Unknown process liveness or start time is not treated as proof of death. A persistent child process per conversation owns turn preparation, AI, MCP, and business operations. The daemon owns admission, persistence, routing, and observation. A child crash records the current turn as failed without automatically retrying it.

## Workspace

Ask to add `/path/to/web`, remove a repository from the assignment, or rename the workspace. Starting from any member repository opens the same workspace. Each goal proceeds in one repository.

Removing an assignment does not delete the repository or its goals. Repositories with unfinished goals cannot be removed; complete or abort those goals first. Starting outside a repository lets you choose a workspace.


Workflows may use names, scope references or file paths, including workflows with merge_pr / close_pr. Set `autoPr` and `shouldPublishBranchToOrigin` on submission when needed; both default to false, retaining worktree isolation and the goal branch as the base.

`takt_remove_goal_task` may cancel pending work while paused. To discard an unintegrated completed result, supply `discardUnmerged: true` and a reason. Running-state, ownership and cleanup-success checks remain.

`takt_merge_goal_pr` requires `cwd`, `goalId`, a `prNumber` matching the saved PR, and `until`, without a conversation ID or director-only authorization. Stopped-state, saved PR and head/base checks remain. Manager may investigate and recover push or PR preparation failures itself; calling `takt_complete_goal` again retries preparation when `awaiting_merge` has no saved PR. Final verification may be delegated, with manager responsible for checking target SHA, methods and result evidence.

## Director responsibilities

### Conversation

Start director in an interactive terminal:

```bash
takt director
takt director --help
```

`takt director` opens a conversation TUI. The daemon owns and runs the conversation; closing and reopening the TUI reconnects to the same conversation. Starting from any assigned repository connects to that same daemon-wide conversation. Previous messages and replies are not redisplayed when you reopen it; conversation history is managed by the provider's session.

Director is experimental. Its behavior and saved data formats may change without notice. Human and event turns incur provider costs; a clock alone does not trigger a model call.

### Responsibilities and human decisions

Manager advances goals within its assigned repository or workspace: it submits tasks, integrates results, and requests completion. Director looks across all managers' goals and unanswered inquiries. It saves notifications for work needing human attention, including goals awaiting merge, paused goals, saved `blocked` notifications, and unanswered inquiries. It can ask or inform a manager through the manager conversation, with `director` recorded as the speaker. Repeated notifications for the same saved target and state are suppressed.

`takt_tell_manager` sends director_message to the dispatcher even during a manager turn and returns an operation ID and manager after durable admission. Director messages enter the other-event queue, behind waiting human input. They use the same manager conversation; replies, failures, and interruptions arrive later with the same operation ID.

Replies, failures, and interruptions are saved with the same operation ID and shown later in the director TUI. If saving the message fails, the tool returns a failure without accepting it. An accepted message remains saved after a lost connection, and director does not automatically resend it.

After a daemon restart, messages that have not started run even without a client connection. Director messages interrupted by daemon shutdown, or found still `running` at startup, are redelivered in their original acceptance order. Explicitly interrupted messages are not redelivered.

Director cannot run shell commands, write files, or change settings. It does not inspect task internals such as run phases, adjudications, or logs; each manager inspects its own tasks. Merge decisions, specification decisions, and irreversible operations such as deletion remain with the human. Director does not answer inquiries on the human's behalf.

Only when the human explicitly says, for example, “merge goal G,” does director ask G's manager to merge its PR using `takt merge`. Before forwarding, director uniquely identifies the repository, goal, and manager, checks that the current goal is `awaiting_merge`, and reads the saved PR number and URL. If the target is ambiguous, the state differs, the PR is missing, or reading fails, it reports the reason without forwarding. Director never performs the merge itself. The manager executes it through `takt_merge_goal_pr`, which invokes `takt merge`. Forwarding or accepting the request alone does not mean the merge succeeded; director reports success or failure from the later result with the same operation ID. At execution time, existing checks prevent merging if the goal is paused, aborted, no longer `awaiting_merge`, or has a different saved PR number.

Manager listing (`takt_list_managers`) reports unreadable projects with reasons and continues with readable managers.

### Events and notifications

Code watchers observe process loss and PR state changes and emit events only for changes or anomalies. Manager patrols run once per repository at the interval described above. Director is never called by a clock. Unknown process liveness or start time is not treated as proof of death. A persistent child process per conversation owns turn preparation, AI, MCP, and business operations. The daemon owns admission, persistence, routing, and observation. A child crash records the current turn as failed without automatically retrying it.

Set director options in global `~/.takt/config.yaml`, not project `.takt/config.yaml`:

| Setting | Meaning |
|---------|---------|
| `director.slack.channel_id` | Slack channel for director conversations and grouped notifications. |
| `director.slack.allowed_user_ids` | Users allowed to talk to director from Slack; required when `director.slack` is configured. An empty list accepts no users. |

See the [global config field reference](./configuration.md#global-config-field-reference).

### Slack connection

Use the same Slack App and `TAKT_SLACK_APP_TOKEN` / `TAKT_SLACK_BOT_TOKEN` environment variables as manager. Invite the bot to the director channel, set both variables in the shell that starts `takt daemon`, and restart the daemon after changing Slack settings. Keep tokens in environment variables rather than configuration files.

Messages from allowed users enter the same director conversation, and replies go to the originating thread. New notifications from one turn are grouped into one channel post. Without `director.slack`, director neither posts to nor accepts messages from Slack. Follow [Slack conversations with director](./configuration.md#slack-conversations-with-director) for the App setup and connection details.

## Slack conversations

In a conversation thread, send `/make-goal` to create a proposal. Use **Register goal** or **Return to conversation without registering**; buttons on an outdated proposal no longer work.

You can talk to manager from one configured Slack channel using Socket Mode, without exposing a public URL. Follow [Slack conversations with manager](./configuration.md#slack-conversations-with-manager) to create and install the App, set `TAKT_SLACK_APP_TOKEN` and `TAKT_SLACK_BOT_TOKEN` in the shell that starts the daemon, and configure `manager.slack` in the repository's `.takt/config.yaml`. Start the daemon with `takt manager` or `takt daemon`.

A post outside a thread receives a reply in that post's thread. Continue there; all conversation threads share the repository's manager conversation with the TUI. Replies go only to the originating thread, and replies to TUI messages do not appear in Slack. Messages sent during processing receive durable acceptance; human input takes priority, and results return to the originating thread. Only the configured channel and `allowed_user_ids` are accepted; DMs to the bot are ignored.

Completion notices and other notifications continue to use the Incoming Webhook configured by `TAKT_NOTIFY_WEBHOOK`, separately from conversation replies. Both can be enabled together.

## Answers, pause and abort

Open menus with the following keys, including while manager is processing.

| Key | Behavior |
|-----|----------|
| `Ctrl+R` | List unanswered inquiries with and without a goal together, then answer the selected inquiry. |
| `Ctrl+G` | List only ongoing goals (active and paused) by short name and state. Use `↑↓` to select a goal and `Enter` to choose pause, resume or abort. |

Pausing stops new submissions, integrations, and running tasks. Stopped tasks remain as retryable failures, and their result events are deferred. On resume, the manager receives the deferred events, decides how to continue the stopped tasks, and advances the work. Before aborting, confirm that the operation is irreversible and that records and branches remain; aborting interrupts the goal's running tasks and invalidates unstarted tasks. `Esc` closes the list without making changes. If there are no eligible targets, the TUI shows a notice instead of opening a list.

Aborting is irreversible. Goal records and branches remain. Answers are saved for the run manager's next decision.

### Answering inquiries

Press `Ctrl+R` to open unanswered inquiries with and without a goal together. Use `↑↓` to select an inquiry and `Enter` to open its details and answer. The list shows up to 10 inquiries at a time; the visible range shifts with the arrow keys for additional items. Use the arrow keys to scroll details that do not fit on screen. `Esc` in the details returns to the list; `Esc` in the list closes it without saving an answer.

Each row shows the inquiry kind, short goal name and summary; select it for details. Questions accept choices or free text. Operation requests save Completed / Unable and an optional comment. Historical tool approvals remain readable and withdrawable but are not answer targets. Permission scope and permission-text saving UI have been removed.

### Reading notifications

Notifications flowing onto the normal screen show only the key points: the heading line, goal line, and first few lines of the body. Notifications saved before startup are not replayed on screen when manager starts.

## Goal operations in conversation

With any provider supporting the required MCP capability, ask manager to pause the previous goal, resume a particular goal, or abort it with a reason, such as changed requirements. The manager identifies the target through the existing list and asks if it cannot be narrowed to one goal. Goal registration still requires approval in the TUI.

Pausing also stops running tasks, which remain as retryable failures. On resume, the manager receives the deferred events, decides how to continue the stopped tasks, and advances the work. Aborting interrupts running tasks and invalidates unstarted tasks. An aborted goal cannot resume. Completed goals cannot be paused or resumed; only active goals can be paused, and only paused goals can resume.

Conversation state tools are exposed for all providers with the required MCP capability. The TUI goal menu opened with `Ctrl+G` is also available.

## Commands for waiting on external state

The manager-only `takt_wait_command` is available in conversations with a daemon request route. It registers a one-line shell command with the daemon and immediately returns its registration ID. Examples include `gh run watch <id> --exit-status`, `gh pr checks <n> --watch`, and `until curl -sf …; do sleep 30; done`. Arguments are `command`, a `description` of what is being awaited, an absolute directory `cwd` inside an assigned repository, and optional `goalId` and `timeoutSeconds`. Subdirectories are preserved as the execution directory. The timeout defaults to 3600 seconds and cannot exceed 86400 seconds. To match the daemon's event admission capacity, at most 32 registrations across the daemon may be running or awaiting completion delivery or retry. New registrations fail with an error at capacity and can be retried once completion delivery frees a slot.

The manager may end its turn after registering. The daemon keeps requests in memory and delivers one `wait_command_completed` event to the requesting conversation after success, failure, timeout, or cancellation caused by a stopped goal. The event contains the registration ID, description, optional goal, status, exit code (`null` when unavailable), signal, elapsed milliseconds, and the last 16 KiB of combined stdout/stderr.

On Windows, if natural exit cannot be distinguished from termination after a Job stop or handle close, the daemon records a stop error and retains the registration, monitoring, and pending deliveries without sending a completion event. A matching Job termination code or successful handle close alone does not establish cancellation or timeout. Daemon shutdown fails at its shared 15-second deadline and can be retried. An unresolved exit cause remains incomplete after retries.

An optional `goalId` must identify an active goal in the selected repository. The daemon checks for goal pause or abort every five seconds and stops the command's process tree. Timeouts also stop the process tree. Daemon shutdown stops requests and their child processes and, when possible, delivers a `cancelled` completion event to the requesting conversation. Registrations are not rerun on restart. During startup patrol, the manager checks current state and registers again if needed.

The daemon executes these commands directly, bypassing the manager's `auto` AI permission review. Use waiting commands only; do not use operations that change state. This usage restriction is described by the tool and is not enforced mechanically.

## Integration and completion

Manager splits work into independently checkable results. Work that does not need each other's results or share change targets runs in parallel within specified ordering and concurrency limits. Human constraints carry into each instruction, with one owner for checks performed once per goal.

Results collect on the goal branch. Manager checks acceptance criteria through diffs, history and run reports, and checks combined results when needed. A goal is complete after integration into its target branch.

Goal completion compares trees with `git merge-tree --write-tree`, which requires Git `>=2.38`; environments that do not meet this requirement receive an error stating the required version.

```yaml
manager:
  main_merge: approve
```

Both `main_merge: approve` and `auto` publish a PR. With the default `approve`, manager calls `takt_merge_goal_pr` with `until: prepare`, finishes preparation and waits for human merge. `auto` is a continuing integration instruction set by the person and uses `until: merge`. An explicit human instruction to merge also uses `until: merge`.

Completion pushes the reviewed SHA to `origin` and creates or reuses a PR from the goal branch to its saved integration target. Failures remain in work logs and `blocked` notifications. Manager inspects causes and side effects and decides what to do next; no timed or counted automatic PR-creation retries run. When no PR is saved, call `takt_complete_goal` again after fixing the cause.

`takt_merge_goal_pr` requires `cwd`, `goalId`, `prNumber` and `until`. It enqueues a pending task with `merge_task: true` and `goal_id` in `tasks.yaml` and immediately returns its name. `prepare` selects `merge-prepare`; `merge` selects `merge.workflow`, defaulting to `merge-review-fix-simple`. Pending or running work for the same target is rejected.

The daemon executes it like other goal tasks: incorporate the target branch, resolve conflicts, review and fix, push, run Caccia and wait for CI. Conflicting PRs use this same path instead of ordinary conflict-fix tasks. PR merge tasks push directly to the PR branch and must not be integrated with `takt_merge_goal_task`. `takt_list_tasks` shows `mergeTask` and completion results. Completion events include `mergeOutcome` (`prepared`, `merged` or `unresolved`) and `branchSynchronization`. When merged, manager completes the goal with `takt_check_goal_completion`.

After push, the original repository fast-forwards its goal branch if it is an ancestor of origin. Divergent histories are preserved and reported as failure in task results and events. Checked-out working copies are preserved and synchronization stops with a report. The same checks run before task integration and completion publication. If synchronization changes the tip, verify acceptance criteria at that new SHA before submitting completion again.

## Stopped work and notifications

Manager can request a stop for one running task with `takt_stop_goal_task` (`manager` and `all` tool sets). Use an absolute `cwd`. From one task item returned by `takt_list_tasks`, pass its `name` value as `taskName` and use its `goalId` and stable `executionId`. The owner PID must be alive. When an owner start time is saved, the current start time must be available and match it. Without a saved start time, matching goalId, taskName and executionId, running status, and a live owner PID are sufficient to accept the request. Mismatched identities, non-running tasks, and ended owners are rejected with a reason without saving a request. The tool saves only the request; the same worker polls every 500 ms, aborts itself, finishes cleanup, then saves `failed` with a task stop reason distinct from a goal abort. The goal and other tasks continue. Repeated requests return the saved request only if the same execution is still `running` and its owner can be verified when the request is evaluated; requeued and retried work receives a new execution ID, so old requests do not stop it. Existing running work can also be stopped while the goal is paused, provided its owner can be verified.

Manager inspects reports and the working location, then chooses requeue, retry with revised instructions, new work or removal. If it cannot resolve the issue, it explains the reason, what it tried and the needed human action through a notification or question, and stops affected work and its dependents. Independent work continues.

Notifications appear in the TUI and Slack and can be switched by kind in [notification settings](./configuration.md#manager-notification-settings). Failed event processing or TUI conversation sends `blocked`. Repeated failures still notify; no failure-state file is created. After resolving the cause, retry the conversation action. Failed turns are not blindly replayed; manager inspects current state and side effects to decide recovery.

Goal memory is saved in `.takt/goals/<UUID>/goal.json`: objective, scope exclusions, acceptance criteria, work constraints, questions and answers, and short records of submissions, integrations, cancellations and reasons. Workspaces are under `~/.takt/workspaces/`, and pending events under `~/.takt/manager-inbox/`. These use `TAKT_CONFIG_DIR` when set.

## Future plans

A choice of Docker or local execution, goals spanning repositories, delegated-work completion notices and adjudication are planned. The director does not yet order work across managers using dependencies, overlapping change targets or combined-result checks.

## Manager goals and formal specifications

`assistant.formal_spec` also applies to manager goal proposals. The manager does not ask at each registration: `true` and `"Y/n"` include both Quint and Alloy, while `false` and `"y/N"` omit them. Project configuration takes precedence over global configuration, resolving object fields independently. `comments` and `model_check_timeout_seconds` use the same settings as interactive mode.

Development and implementation goals use Gherkin for important observable behavior where a misunderstanding would change the result. Do not repeat those expected outcomes in acceptance criteria. Gherkin keywords are English; descriptions may use the conversation language. Goals for research, documentation, operations, or other non-implementation work do not use Gherkin.

Enter `/verify` in the manager conversation in either TUI or Slack to generate Quint and Alloy specifications from the current agreement and run the same checkers as interactive mode. Results return to the same conversation for the manager to interpret diagnostics and counterexamples. When formal specifications are disabled, verification is reported as unavailable. Registration does not automatically run verification, and verification alone does not register a goal or modify its proposal or saved specifications.

Specifications are stored as code bodies in the optional goal field `specifications: { gherkin?, quint?, alloy? }` and displayed in both TUI and Slack proposals. Existing goals without specifications remain readable. As with acceptance criteria, the manager includes complete relevant specifications in assigned task instructions as the basis for implementation and review. Final PR review tasks automatically receive all saved specifications.

Read complete specification bodies using `takt_get_goal` with `path: specifications.gherkin`, `specifications.quint`, or `specifications.alloy`. Specifications are finalized at registration and saved with the goal.

In a workspace, `/verify` uses the configuration of the repository selected in the proposal. Without a proposal, it uses the sole assigned repository if there is one. When multiple repositories are assigned, it does not start verification and asks you to specify the target and create a proposal with `/make-goal`.
