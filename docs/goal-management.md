# Local goals and manager workspaces

`takt manager` is an experimental conversation TUI. Discuss the objective, exclusions, acceptance criteria and work constraints, then review and approve the displayed summary. Registration happens directly from the TUI; conversation text is not approval. Goals are stored in `.takt/goals/<UUID>/goal.json` in their target repository. Automatic task execution incurs provider usage costs.

## Register and run a goal

Start `takt manager` in an interactive terminal. After approval, the manager submits tasks from the goal branch and normally starts pending work automatically. Disable automatic execution if you want to run `takt run` or `takt watch` yourself:

```yaml
manager:
  auto_run: false
  default_workflow: default
```

The goal summary preserves work constraints separately from acceptance criteria. Each applicable task receives those constraints. See the [configuration guide](./configuration.md) for manager settings.

## Manage several repositories with a workspace

Ask the manager to “also manage `/path/to/web`” to add a Git repository. The manager checks that it does not belong to another workspace. Adding a second repository to a standalone assignment creates a workspace. You can also ask to remove a repository or rename the workspace. Removal changes membership and leaves repositories and goals intact. Unfinished goals prevent removal, with their IDs included in the error. Paused goals count as unfinished; completed and aborted goals do not.

Records live in `~/.takt/workspaces/<ID>/workspace.json` and contain the ID, name and assigned repository list. Each repository belongs to at most one workspace. With `TAKT_CONFIG_DIR`, records live under that directory instead.

Starting `takt manager` in any member repository or its subdirectories opens the same workspace. Unassigned repositories use a standalone manager. Starting outside repositories offers workspace selection, or explains how to create one and exits when none exist. The TUI displays the workspace name and repository count, or the standalone repository name. An empty workspace can be selected to add repositories again.

Goal approval shows the target repository. Each goal stays within that repository; goals spanning repositories are not supported. Task and goal MCP operations are restricted to the current assignment, including separate repositories nested inside assigned repositories.

Assignment tools are manager-only: `takt_add_workspace_repository`, `takt_remove_workspace_repository`, and `takt_rename_workspace`. Additions and removals take `repositoryDirectory`; renaming takes `name`. They do not take `cwd`. Regular task and goal tools take the target repository as `cwd`.

## Goal operations

Enter these commands as separate lines in the TUI:

| Command | Action |
|---------|--------|
| `/pause <goalId>` | Pause new submissions and integration. Running work continues. |
| `/resume <goalId>` | Resume the goal and process pending results. |
| `/abort <goalId>` | Confirm irreversible abortion of the goal. Records and branches remain. |
| `/answer <questionId>` | Answer a pending human question. |

The manager reads task state, run reports and Git results before deciding what to submit, retry, remove or integrate. Goal work remains within its repository and is complete after integration into its configured target branch. The repository's `manager.main_merge` defaults to `approve`, which requires human integration. With `auto`, the manager may integrate reviewed results; a target checked out in a worktree still requires human integration.
