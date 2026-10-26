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

The judge has a short deadline. A timeout, exception, or invalid decision format denies the operation, without an automatic retry of the judgment.

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

The daemon periodically inspects unfinished active goals. `manager.patrol_interval` is a positive integer in seconds, defaulting to `1800` (30 minutes); project settings override global settings. The first patrol for a new goal is measured from creation, and later patrols from the previous completion. It checks long-running work, repeated steps, stalled goals and unanswered questions, then resumes, retries or notifies as needed. For running tasks, manager can request an individual stop; issues it cannot resolve are reported to a person. Failed patrols send `blocked` and are checked again after the interval. Ordinary failed events remaining in the inbox are also retried during patrol.

## Workspace

Ask to add `/path/to/web`, remove a repository from the assignment, or rename the workspace. Starting from any member repository opens the same workspace. Each goal proceeds in one repository.

Removing an assignment does not delete the repository or its goals. Repositories with unfinished goals cannot be removed; complete or abort those goals first. Starting outside a repository lets you choose a workspace.

## Answers, pause and abort

Open menus with the following keys, including while manager is processing.

| Key | Behavior |
|-----|----------|
| `Ctrl+R` | List unanswered inquiries with and without a goal together, then answer the selected inquiry. |
| `Ctrl+G` | List only ongoing goals (active and paused) by short name and state. Use `↑↓` to select a goal and `Enter` to choose pause, resume or abort. |

Pausing stops new submissions and integrations while running tasks continue and results are deferred. Resuming advances deferred events and tasks. Before aborting, confirm that the operation is irreversible and that records and branches remain; aborting interrupts the goal's running tasks and invalidates unstarted tasks. `Esc` closes the list without making changes. If there are no eligible targets, the TUI shows a notice instead of opening a list.

Aborting is irreversible. Goal records and branches remain. Answers are saved for the run manager's next decision. Receiving answers from Slack is not implemented.

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

A choice of Docker or local execution, and goals spanning repositories are planned. A director would coordinate several managers, forward questions, receive delegated-work completion notices and support adjudication. It would order work across managers using dependencies, overlapping change targets and checks of combined results. These features are not implemented.
