# Managing goals with manager

`takt manager` is an experimental TUI for discussing goals and coordinating work. Manager and task execution incur provider costs.

## Discussion and registration

Start `takt manager` in an interactive terminal and describe the objective, scope exclusions, acceptance criteria and work constraints. Review the summary and choose Approve registration to let the TUI register the goal. Choose Continue conversation to revise it.

After registration, the manager inside the daemon handles events, submits tasks, checks and integrates results, and selects next work. The TUI displays work records and lets you continue the conversation with a manager that receives those records. Closing the TUI leaves an already running run active.

By default, required runs start automatically. Disable this to start `takt run` / `takt watch` yourself.

```yaml
manager:
  auto_run: false
  default_workflow: default
```

Manager supports Claude, Codex and OpenCode. Its tools use existing TAKT features for submission, requeue, retry, removal, run inspection, diffs, history, integration and completion checks. Before acting, it checks tasks, run records and reports, and git, without repeating finished actions.

Both the TUI and daemon manager use `full` permissions through the existing provider permission controls. Manager can use the provider's normal tools and user MCP servers, subject to the tool review for claude (claude-sdk) or codex described here. Configured provider options are preserved.

In manager conversations with the claude (claude-sdk) or codex provider, an AI permission judge reviews tool use before execution instead of asking a person to approve every operation. It decides to allow, deny with a reason, or ask a person. This review is enabled by default and has no on/off setting.

With claude (claude-sdk), only the built-in read tools `Read`, `Glob`, `Grep`, and `ToolSearch`, and the manager's own TAKT MCP tools, run without this review. With Codex, only the manager's own TAKT MCP tools run without review; all built-in tools are reviewed. For both providers, all other tools are reviewed, including unknown tools and external MCP tools. Shell execution, including `Bash`, is reviewed every time, even when the command appears to be read-only. Launching another agent through `Task` or `Agent` is always denied, as are instructions to launch another AI command-line agent through `Bash`. With Codex, `spawn_agent` is also always denied without invoking the permission judge.

When an operation is denied, the reason returns to the manager, which takes it into account in its next response. An “ask a person” decision also denies the operation for now and notifies the TUI and Slack that human confirmation is pending, with the reason. The operation is not held open while waiting. These notifications use existing kinds; no new notification kind is added.

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

The daemon periodically inspects unfinished active goals. `manager.patrol_interval` is a positive integer in seconds, defaulting to `1800` (30 minutes); project settings override global settings. The first patrol for a new goal is measured from creation, and later patrols from the previous completion. It checks long-running work, repeated steps, stalled goals and unanswered questions, then resumes, retries or notifies as needed. Problems in running tasks are reported to a person. Failed patrols send `blocked` and are checked again after the interval. Ordinary failed events remaining in the inbox are also retried during patrol.

## Workspace

Ask to add `/path/to/web`, remove a repository from the assignment, or rename the workspace. Starting from any member repository opens the same workspace. Each goal proceeds in one repository.

Removing an assignment does not delete the repository or its goals. Repositories with unfinished goals cannot be removed; complete or abort those goals first. Starting outside a repository lets you choose a workspace.

## Answers, pause and abort

Enter each command on its own line in the TUI.

| Command | Behavior |
|---------|----------|
| `/answer <questionId>` | Answer with an option or free text. |
| `/pause <goalId>` | Stop new submissions and integrations. Running tasks continue and results are deferred. |
| `/resume <goalId>` | Resume deferred events and tasks. |
| `/abort <goalId>` | Abort after confirmation, interrupting this goal's running tasks and invalidating unstarted tasks. |

Aborting is irreversible. Goal records and branches remain. Answers are saved for the run manager's next decision. Receiving answers from Slack is not implemented.

## Integration and completion

Manager splits work into independently checkable results. Work that does not need each other's results or share change targets runs in parallel within specified ordering and concurrency limits. Human constraints carry into each instruction, with one owner for checks performed once per goal.

Results collect on the goal branch. Manager checks acceptance criteria through diffs, history and run reports, and checks combined results when needed. A goal is complete after integration into its target branch.

```yaml
manager:
  main_merge: approve
```

The default `approve` waits for a human merge and displays steps. After merging, ask manager to check completion. `auto` integrates automatically, but waits for a person when the target is checked out.

## Stopped work and notifications

Manager inspects reports and the working location, then chooses requeue, retry with revised instructions, new work or removal. If it cannot resolve the issue, it explains the reason, what it tried and the needed human action through a notification or question, and stops affected work and its dependents. Independent work continues.

Notifications appear in the TUI and Slack and can be switched by kind in [notification settings](./configuration.md#manager-notification-settings). Failed event processing or TUI conversation sends `blocked`. Repeated failures still notify; no failure-state file is created. After resolving the cause, retry the conversation action or start `takt run`.

Goal memory is saved in `.takt/goals/<UUID>/goal.json`: objective, scope exclusions, acceptance criteria, work constraints, questions and answers, and short records of submissions, integrations, cancellations and reasons. Workspaces are under `~/.takt/workspaces/`, and pending events under `~/.takt/manager-inbox/`. These use `TAKT_CONFIG_DIR` when set.

## Future plans

A choice of Docker or local execution, and goals spanning repositories are planned. A director would coordinate several managers, forward questions, receive delegated-work completion notices and support adjudication. It would order work across managers using dependencies, overlapping change targets and checks of combined results. These features are not implemented.
