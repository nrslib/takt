# Managing goals with manager

`takt manager` is an experimental TUI for discussing goals and coordinating work. Manager and task execution incur provider costs.

## Discussion and registration

Start `takt manager` in an interactive terminal and describe the objective, scope exclusions, acceptance criteria and work constraints. Manager starts the daemon if needed and waits until it is ready; the TUI connects to it to send requests and display results. Type `/make-goal` in the input box and press `Enter` to create a goal proposal from the conversation. Review the displayed proposal and use `↑` Approve / `↓` Continue / `Enter` Confirm. Select Approve and press `Enter` to ask the daemon to register the goal. Choose Continue conversation to revise it.

Even when a proposal is already displayed, `/make-goal` only regenerates it from the current conversation; it does not register the goal. Registration requires selecting Approve and pressing `Enter`. If there is insufficient material, manager explains this and you can continue the conversation. Manager can also offer a goal proposal itself.

The top of the normal screen has two lines: the assignment name on the first, and the counts of ongoing goals (active and paused) and unanswered inquiries on the second. It does not list completed or aborted goals or inquiry bodies. Typing `/` in the input box shows `/make-goal` as a completion candidate; press `Tab` to accept it. Input starting with `/` other than `/make-goal` is sent to manager as a regular message.

The hints below the input box appear on two lines:

```text
Enter Send  Shift+Enter Newline  Esc Interrupt  ^R Inquiries  ^G Goals  ^C Exit
/make-goal to create a goal proposal
```

The daemon owns and runs manager conversations. Once a turn is accepted, closing the TUI only disconnects that screen; the turn continues in the daemon. Reopening manager for the same repository or workspace, or opening a second TUI for that assignment, connects to the same conversation. A pending goal proposal is shown again and can be registered by selecting Approve and pressing `Enter`, but previous messages and replies are not redisplayed. TAKT does not save conversation text; history is managed by the provider's session. Pending summaries and goal records are saved separately.

Another message submitted while the same conversation is processing is rejected as busy and will not run later. Submit it again after processing finishes. After a daemon restart, a turn that was running is treated as interrupted, and new messages can be accepted. The daemon does not exit automatically while a TUI is connected or an accepted conversation operation is running. Use `takt daemon stop` for an explicit stop.

After registration, the manager inside the daemon handles events, submits tasks, checks and integrates results, and selects next work. The TUI displays work records and lets you continue the conversation with a manager that receives those records. Closing the TUI also leaves an already running run active.

By default, required runs start automatically. Disable this to start `takt run` / `takt watch` yourself.

```yaml
manager:
  auto_run: false
  default_workflow: default
```

Manager supports Claude, Codex and OpenCode. Its tools use existing TAKT features for submission, requeue, retry, removal, run inspection, diffs, history, integration and completion checks. Before acting, it checks tasks, run records and reports, and git, without repeating finished actions.

Use these tools for inquiries that do not belong to a goal.

| Tool | Purpose |
|------|---------|
| `takt_list_standalone_inquiries` | Read unanswered inquiries without a goal saved under the current assignment, including their id, kind, body and creation time. |
| `takt_withdraw_standalone_inquiry` | Withdraw an unanswered inquiry without a goal by passing its id and a reason. An inquiry that is no longer unanswered keeps both its state and saved answer unchanged. |

Every turn, manager reviews unanswered inquiries both with and without a goal. It withdraws inquiries that no longer matter, such as approval for an operation that is no longer running, with a reason and records that reason in work records. It keeps inquiries that still need a human decision.

The daemon runs both manager conversations and event processing with `full` permissions through the existing provider permission controls. Manager can use the provider's normal tools and user MCP servers, subject to the tool review for claude (claude-sdk) or codex described here. Configured provider options are preserved.

In manager conversations with the claude (claude-sdk) or codex provider, an AI permission judge reviews tool use before execution instead of asking a person to approve every operation. It decides to allow, deny with a reason, or ask a person. This review is enabled by default and has no on/off setting.

With claude (claude-sdk), `Read`, `Glob`, and `Grep` run without review only when their resolved targets are readable, ordinary files inside the manager's assigned repositories (the workspace members, or the current repository when it has no workspace). Relative paths use the tool's actual working directory; `~`, `..`, and symlinks are resolved before comparison. Targets outside the assignment, sensitive files, and targets or search ranges that cannot be determined are sent to the judge. Sensitive defaults cover `.env`, `.env.*`, SSH private key names (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`), and `*.key`, `*.pem`, `*.crt`, `*.cer`, `*.p12`, `*.pfx`. Global and project `manager.sensitive_paths` add to these defaults and cannot remove them. `ToolSearch` and the manager's own TAKT MCP tools continue to run without review. With Codex, only the manager's own TAKT MCP tools run without review; all built-in tools are reviewed. For both providers, all other tools, including unknown tools and external MCP tools, are reviewed when no saved approval applies. Shell execution, including `Bash`, is reviewed every time no saved approval applies, even when the command appears to be read-only. Launching another agent through `Task` or `Agent` is always denied, as are instructions to launch another AI command-line agent through `Bash`. With Codex, `spawn_agent` is also always denied without invoking the permission judge.

When an operation is denied, the reason returns to the manager, which takes it into account in its next response. An “ask a person” decision also denies the operation for now and notifies the TUI and Slack that human confirmation is pending, with the reason. The operation is not held open while waiting. These notifications use existing kinds; no new notification kind is added.

Saved approvals apply only when the tool name, digest of the original arguments, working directory and target SHA match. Goal operations are bound to the current goal branch SHA. A usable approval allows the operation without calling the judge. A `once` approval allows one use only after consumption is saved; subsequent uses require confirmation again, and a consumption save failure denies the operation. Saved denials return the human reason. Pending inquiries deny with the same inquiry ID. Answers, consumption and assignment changes are reloaded for each request.

The source of approval records is the target repository's `.takt/goals/<UUID>/goal.json` for a goal, or the current assignment's `~/.takt/workspaces/<UUID>/inquiries/` or `~/.takt/projects/<project-id>/inquiries/` otherwise. Answers from other goals or assignments are not reused.

Each judgment receives the original global `~/.takt/manager-permissions.md`, current workspace `~/.takt/workspaces/<UUID>/manager-permissions.md`, target project `~/.takt/manager-permissions/projects/<project-id>.md`, and allowed goal answers with scope `goal`, with their scope and actual source path. The project ID is the SHA-256 of the canonical repository path. These paths use `TAKT_CONFIG_DIR` when set. Human-edited Markdown remains limited to three scopes; no goal Markdown or repository permission file is added. No AI tool can edit permission files.

Read failures, invalid UTF-8, or exceeding 8KiB per source or 32KiB in total are reported to the judge and require human confirmation. Goal limits count the selected permission answer texts together, excluding unrelated goal fields. Source text is not truncated to allow an operation, and saved approval cannot bypass read failures. Existing prohibitions and goal constraints take precedence, followed by denial, confirmation every time, then permission. Goal pause, resume and abort tool requests normally require human confirmation, including the irreversible nature of abort.

Set the judge's provider and model through `provider.targets.internal_agents.manager-permission-judge` in `runtime.yaml`. Like other internal agent seats, it accepts `profile` or `ladder`, but not `pool`. If unassigned, it uses the same provider, model, and provider options as the manager.

The judge has a 30-second deadline. A timeout follows the same human confirmation flow as an “ask a person” decision: an approval inquiry is saved, the operation is stopped pending confirmation, and a notification is sent. Exceptions and invalid decision formats still deny the operation. The judgment is not retried automatically.

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

## Patrol

Before processing each project's events, the daemon recovers interrupted tasks as `failed` and creates completion events for goal tasks. Recovery runs even without pending tasks, so restarting `takt run` is unnecessary. The manager reads the recovered task state when handling patrol events. Recovery failures are logged and passed to the existing patrol-interval and shutdown notification checks while subsequent processing continues. Recovery requires an absent or dead owner PID, or a known mismatch between the saved and current owner start times. A live PID with unavailable saved or current owner identity is left running.

The daemon periodically inspects unfinished active goals. `manager.patrol_interval` is a positive integer in seconds, defaulting to `900` (15 minutes); project settings override global settings. The first patrol for a new goal is measured from creation, and later patrols from the previous completion. It checks long-running work, repeated steps, stalled goals and unanswered questions, then resumes, retries or notifies as needed. For running tasks, manager can request an individual stop; issues it cannot resolve are reported to a person. Failed patrols send `blocked` and are checked again after the interval. Ordinary failed events remaining in the inbox are also retried during patrol.

## Workspace

Ask to add `/path/to/web`, remove a repository from the assignment, or rename the workspace. Starting from any member repository opens the same workspace. Each goal proceeds in one repository.

Removing an assignment does not delete the repository or its goals. Repositories with unfinished goals cannot be removed; complete or abort those goals first. Starting outside a repository lets you choose a workspace.

## Director patrol

### Conversation

Start director in an interactive terminal:

```bash
takt director
takt director --help
```

`takt director` opens a conversation TUI. The daemon owns and runs the conversation; closing and reopening the TUI reconnects to the same conversation. Starting from any assigned repository connects to that same daemon-wide conversation. Previous messages and replies are not redisplayed when you reopen it; conversation history is managed by the provider's session.

Director is experimental. Its behavior and saved data formats may change without notice. Conversations incur provider costs, and scheduled patrols also call the provider and incur costs.

### Responsibilities and human decisions

Manager advances goals within its assigned repository or workspace: it submits tasks, integrates results, and requests completion. Director looks across all managers' goals and unanswered inquiries. It saves notifications for work needing human attention, including goals awaiting merge, paused goals, saved `blocked` notifications, and unanswered inquiries. It can ask or inform a manager through the manager conversation, with `director` recorded as the speaker. Repeated notifications for the same saved target and state are suppressed.

Director cannot run shell commands, write files, or change settings. It does not inspect task internals such as run phases, adjudications, or logs; each manager inspects its own tasks. Merge decisions, specification decisions, and irreversible operations such as deletion remain with the human. Director does not answer inquiries on the human's behalf.

Only when the human explicitly says, for example, “merge goal G,” does director ask G's manager to merge its PR using `takt merge`. Before forwarding, director uniquely identifies the repository, goal, and manager, checks that the current goal is `awaiting_merge`, and reads the saved PR number and URL. If the target is ambiguous, the state differs, the PR is missing, or reading fails, it reports the reason without forwarding. Director never performs the merge itself. The manager executes it through `takt_merge_goal_pr`, which invokes `takt merge`; forwarding or accepting the request alone does not mean the merge succeeded. A busy response or a lost connection does not cause queuing or automatic resending.

### Patrol settings

While the daemon is running, director periodically inspects registered repository and workspace managers. Patrols run independently of the human conversation and do not count as human merge instructions. The daemon retains its existing idle-exit behavior.

Set director options in global `~/.takt/config.yaml`, not project `.takt/config.yaml`:

| Setting | Meaning |
|---------|---------|
| `director.patrol_interval` | Patrol interval in seconds; a positive integer, default `900` (15 minutes). |
| `director.slack.channel_id` | Slack channel for director conversations and grouped notifications. |
| `director.slack.allowed_user_ids` | Users allowed to talk to director from Slack; required when `director.slack` is configured. An empty list accepts no users. |

See the [global config field reference](./configuration.md#global-config-field-reference).

### Slack connection

Use the same Slack App and `TAKT_SLACK_APP_TOKEN` / `TAKT_SLACK_BOT_TOKEN` environment variables as manager. Invite the bot to the director channel, set both variables in the shell that starts `takt daemon`, and restart the daemon after changing Slack settings. Keep tokens in environment variables rather than configuration files.

Messages from allowed users enter the same director conversation, and replies go to the originating thread. New notifications from one conversation turn or patrol are grouped into one channel post. Without `director.slack`, director neither posts to nor accepts messages from Slack. Follow [Slack conversations with director](./configuration.md#slack-conversations-with-director) for the App setup and connection details.

## Slack conversations

In a conversation thread, send `/make-goal` to create a proposal. Use **Approve registration** or **Continue conversation**; buttons on an outdated proposal no longer work.

You can talk to manager from one configured Slack channel using Socket Mode, without exposing a public URL. Follow [Slack conversations with manager](./configuration.md#slack-conversations-with-manager) to create and install the App, set `TAKT_SLACK_APP_TOKEN` and `TAKT_SLACK_BOT_TOKEN` in the shell that starts the daemon, and configure `manager.slack` in the repository's `.takt/config.yaml`. Start the daemon with `takt manager` or `takt daemon`.

A post outside a thread receives a reply in that post's thread. Continue there; all conversation threads share the repository's manager conversation with the TUI. Replies go only to the originating thread, and replies to TUI messages do not appear in Slack. Messages sent while manager is processing receive a busy response and are not executed later; resend them after processing finishes. Only the configured channel and `allowed_user_ids` are accepted; DMs to the bot are ignored.

Each inquiry (a question, approval, or operation request) is a new post outside any thread in the configured channel. Answer approval decisions (Allow or Deny and scope) and choices with buttons. Choosing an approval scope broader than this time only opens a modal; edit and confirm the proposed sentence to append it to permission Markdown. Answer free-text inquiries in the inquiry post's thread. When its inquiry binding is available, the reply is treated as an answer rather than a manager conversation message. Answers are saved with source `slack`. See the [configuration guide](./configuration.md#slack-conversations-with-manager) for pending inquiries and binding failure behavior.

Completion notices and other notifications continue to use the Incoming Webhook configured by `TAKT_NOTIFY_WEBHOOK`, separately from conversation replies. Both can be enabled together.

## Answers, pause and abort

Open menus with the following keys, including while manager is processing.

| Key | Behavior |
|-----|----------|
| `Ctrl+R` | List unanswered inquiries with and without a goal together, then answer the selected inquiry. |
| `Ctrl+G` | List only ongoing goals (active and paused) by short name and state. Use `↑↓` to select a goal and `Enter` to choose pause, resume or abort. |

Pausing stops new submissions and integrations while running tasks continue and results are deferred. Resuming advances deferred events and tasks. Before aborting, confirm that the operation is irreversible and that records and branches remain; aborting interrupts the goal's running tasks and invalidates unstarted tasks. `Esc` closes the list without making changes. If there are no eligible targets, the TUI shows a notice instead of opening a list.

Aborting is irreversible. Goal records and branches remain. Answers are saved for the run manager's next decision.

### Answering inquiries

Press `Ctrl+R` to open unanswered inquiries with and without a goal together. Use `↑↓` to select an inquiry and `Enter` to open its details and answer. The list shows up to 10 inquiries at a time; the visible range shifts with the arrow keys for additional items. Use the arrow keys to scroll details that do not fit on screen. `Esc` in the details returns to the list; `Esc` in the list closes it without saving an answer.

Each list row shows the kind, short goal name ("No goal" for inquiries without a goal), and summary. The body, options and recommendation appear after selection. Questions accept an option or free text. Approvals require explicit Allow or Deny with an optional comment, including denial without a comment. Operation requests display the procedure and offer Completed or Unable with an optional comment. Comments alone never imply approval or completion.

Approval defaults to this time only. Other scopes are this goal, project, manager (workspace), and global. Standalone approvals omit this goal. With one repository, project and manager share one choice saved as project scope; adding a repository later does not expand existing permissions.

For project, workspace and global scopes, edit and confirm the proposed permission sentence. When no proposal is saved, the TUI initializes it from the tool, target and execution directory. The TUI sends the confirmed sentence to the daemon, which appends it to permission Markdown before saving the answer. An append failure retains the pending inquiry and edited sentence; resolve the cause and press Enter to retry. Standalone approvals persist and can be answered after opening a new TUI.

### Reading notifications

Notifications flowing onto the normal screen show only the key points: the heading line, goal line, and first few lines of the body. Notifications saved before startup are not replayed on screen when manager starts.

## Goal operations in conversation

With a Claude (claude-sdk) or Codex manager, ask to pause the previous goal, resume a particular goal, or abort it with a reason, such as changed requirements. The manager identifies the target through the existing list and asks if it cannot be narrowed to one goal. Goal registration still requires approval in the TUI.

Pause, resume and abort go through the permission judge and execute after human confirmation. Pending confirmation does not execute the operation. Before aborting, confirm that it cannot be undone and that goal records and branches remain. Running tasks continue while paused; resuming advances deferred work. Aborting interrupts running tasks and invalidates unstarted tasks. An aborted goal cannot resume. Completed goals cannot be paused or resumed; only active goals can be paused, and only paused goals can resume.

Providers without the permission judge do not expose conversation state tools. Open the TUI goal menu with `Ctrl+G` to choose pause, resume or abort.

## Integration and completion

Manager splits work into independently checkable results. Work that does not need each other's results or share change targets runs in parallel within specified ordering and concurrency limits. Human constraints carry into each instruction, with one owner for checks performed once per goal.

Results collect on the goal branch. Manager checks acceptance criteria through diffs, history and run reports, and checks combined results when needed. A goal is complete after integration into its target branch.

Goal completion compares trees with `git merge-tree --write-tree`, which requires Git `>=2.38`; environments that do not meet this requirement receive an error stating the required version.

```yaml
manager:
  main_merge: approve
```

The default `approve` waits for a human merge and displays steps. After merging, ask manager to check completion. `auto` integrates automatically, but waits for a person when the target is checked out.

## Stopped work and notifications

Manager can request a stop for one running task with `takt_stop_goal_task` (`manager` and `all` tool sets). Use an absolute `cwd`. From one task item returned by `takt_list_tasks`, pass its `name` value as `taskName` and use its `goalId` and stable `executionId`. The owner PID must be alive. When an owner start time is saved, the current start time must be available and match it. Without a saved start time, matching goalId, taskName and executionId, running status, and a live owner PID are sufficient to accept the request. Mismatched identities, non-running tasks, and ended owners are rejected with a reason without saving a request. The tool saves only the request; the same worker polls every 500 ms, aborts itself, finishes cleanup, then saves `failed` with a task stop reason distinct from a goal abort. The goal and other tasks continue. Repeated requests return the saved request only if the same execution is still `running` and its owner can be verified when the request is evaluated; requeued and retried work receives a new execution ID, so old requests do not stop it. Existing running work can also be stopped while the goal is paused, provided its owner can be verified.

Manager inspects reports and the working location, then chooses requeue, retry with revised instructions, new work or removal. If it cannot resolve the issue, it explains the reason, what it tried and the needed human action through a notification or question, and stops affected work and its dependents. Independent work continues.

Notifications appear in the TUI and Slack and can be switched by kind in [notification settings](./configuration.md#manager-notification-settings). Failed event processing or TUI conversation sends `blocked`. Repeated failures still notify; no failure-state file is created. After resolving the cause, retry the conversation action. Failed events are retried during patrol.

Goal memory is saved in `.takt/goals/<UUID>/goal.json`: objective, scope exclusions, acceptance criteria, work constraints, questions and answers, and short records of submissions, integrations, cancellations and reasons. Workspaces are under `~/.takt/workspaces/`, and pending events under `~/.takt/manager-inbox/`. These use `TAKT_CONFIG_DIR` when set.

## Future plans

A choice of Docker or local execution, goals spanning repositories, delegated-work completion notices and adjudication are planned. The director does not yet order work across managers using dependencies, overlapping change targets or combined-result checks.
