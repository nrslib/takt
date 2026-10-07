# Task Management

[English](./task-management.md) | [日本語](./task-management.ja.md) | [简体中文](./task-management.zh-CN.md)

## Overview

TAKT provides a task management workflow for accumulating multiple tasks and executing them in batch. The basic flow is:

1. **`takt add`** -- Refine task requirements through AI conversation and save to `.takt/tasks.yaml`
2. **Tasks accumulate** -- Edit `order.md` files, attach reference materials
3. **`takt run`** -- Execute all pending tasks at once (sequential or parallel)
4. **`takt list`** -- Review results, merge branches, retry failures, or add instructions

Each task executes in an isolated clone (optional), produces reports, and creates a branch that can be merged or discarded via `takt list`.

## Adding Tasks (`takt add`)

Use `takt add` to create a new task entry in `.takt/tasks.yaml`.

```bash
# Add a task with inline text
takt add "Implement user authentication"

# Add a task from a GitHub Issue
takt add #28
```

When adding a task, you are prompted for:

- **Workflow** -- Which workflow to use for execution
- **Base branch** -- When the current branch is not `main`/`master`, whether to use it as the base branch
- **Worktree path** -- Where to create the isolated clone (Enter for auto, or specify a path)
- **Branch name** -- Custom branch name (Enter for auto-generated `takt/{timestamp}-{slug}`)
- **Auto-PR** -- Whether to automatically create a pull request after successful execution (default: Yes)
- **Draft PR** -- When Auto-PR is enabled, whether to create the PR as a draft (`Create as draft?`)

### GitHub Issue Integration

When you pass an issue reference (e.g., `#28`), TAKT fetches the issue title, body, labels, and comments via the GitHub CLI (`gh`) and uses them as the task content. The issue number is recorded in `tasks.yaml` and reflected in the branch name.

**Requirement:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

### Saving Tasks from Interactive Mode

You can also save tasks from interactive mode. After refining requirements through conversation, use `/save` (or the save action when prompted) to persist the task to `tasks.yaml` instead of executing immediately.

In ordinary interactive mode, press Escape at any worktree-settings prompt after selecting **Save as Task** to cancel that save and return to the action menu. The confirmed instruction and its attachments stay in the same conversation. Selecting **Save as Task** again starts the settings questions from the beginning without reusing answers from the cancelled attempt.

### Saving Tasks from MCP Clients

MCP clients can use the `takt-mcp` stdio server to save pending tasks, inspect task/run state, and send additional instructions to running worktree-clone tasks without invoking shell commands. `takt_enqueue_task` writes a pending record to `.takt/tasks.yaml`; `takt_list_tasks` returns compact summaries, `takt_get_run` reads one run's details, and `takt_tell_run` rechecks and writes only to a running clone. If saving fails after issue creation and the issue number was resolved, the issue remains open and the MCP error result returns its number for retry. If number extraction fails, the result can provide the issue URL instead. The tools require an absolute `cwd` inside the server's allowed project root; enqueue and tell also require non-empty task content. Use `takt run` to execute pending tasks or `takt watch` to monitor and execute them continuously. See [CLI Reference](./cli-reference.md#mcp-server) for setup and tool input details.

The ordinary assistant conversation receives only the read-only task-state tools when its provider supports MCP. Use `/go` for a new task, `/tell` to select, review, and confirm an additional instruction for a running worktree clone, or `/requeue` and `/retry` to return a failed task to the queue. A provider without MCP support keeps the conversation available but cannot look up task state.

## Task Directory Format

TAKT stores task metadata in `.takt/tasks.yaml` and each task's detailed specification in `.takt/tasks/{slug}/`.

### `tasks.yaml` Schema

```yaml
tasks:
  - name: add-auth-feature
    status: pending
    task_dir: .takt/tasks/20260201-015714-implement-user-authentication
    workflow: default
    created_at: "2026-02-01T01:57:14.000Z"
    started_at: null
    completed_at: null
```

Fields:

| Field | Description |
|-------|-------------|
| `name` | AI-generated task slug |
| `status` | `pending`, `running`, `completed`, `failed`, `exceeded`, or `pr_failed` (workflow succeeded but PR creation/push failed) |
| `task_dir` | Path to the task directory containing `order.md` |
| `workflow` | Workflow name to use for execution |
| `worktree` | `true` (auto), a path string, or omitted (run in current directory) |
| `branch` | Branch name (auto-generated if omitted) |
| `base_branch` | Base branch for the clone and PR (set when chosen at `takt add`) |
| `auto_pr` | Whether to auto-create a PR after execution |
| `draft_pr` | Whether the auto-created PR is opened as a draft |
| `issue` | Issue number from the configured issue provider (if applicable) |
| `run_slug` | Slug of the latest run directory under `.takt/runs/` |
| `failure` | Failure details (`step`, `error`, `last_message`) recorded for failed tasks |
| `created_at` | ISO 8601 timestamp |
| `started_at` | ISO 8601 timestamp (set when execution begins) |
| `completed_at` | ISO 8601 timestamp (set when execution finishes) |

`tasks.yaml` may also contain additional fields (`slug`, `source_run_slug`, `resume_mode`, `owner_pid`, `auto_requeue_count`, `exceeded_*`, etc.) that TAKT manages internally.

### Task Directory Layout

```text
.takt/
  tasks/
    20260201-015714-implement-user-authentication/
      order.md          # Task specification (auto-generated, editable)
      schema.sql        # Attached reference materials (optional)
      wireframe.png     # Attached reference materials (optional)
  tasks.yaml            # Task metadata records
  runs/
    20260201-020152-implement-user-authentication-x7k2pq/
      reports/           # Execution reports (auto-generated)
      logs/              # NDJSON session logs
      context/           # Snapshots (previous_responses, etc.)
      operations/        # Operation journal (journal.json)
      meta.json          # Run metadata
```

The run directory slug is generated separately for each execution by appending a random 6-character suffix, so it differs from the task directory slug. To locate a task's run directory, check the `run_slug` field in `tasks.yaml` or the newest directory under `.takt/runs/`.

`takt add` creates `.takt/tasks/{slug}/order.md` automatically and saves the `task_dir` reference to `tasks.yaml`. You can freely edit `order.md` and add supplementary files (SQL schemas, wireframes, API specs, etc.) to the task directory before execution.

## Executing Tasks (`takt run`)

Execute all pending tasks from `.takt/tasks.yaml`:

```bash
takt run

# Ignore workflow max_steps and continue until another stop condition occurs
takt run --ignore-exceed
```

The `run` command claims pending tasks and executes them through the configured workflow. Each task goes through:

1. Clone creation (if `worktree` is set)
2. Workflow execution in the clone/project directory
3. Auto-commit and push (if worktree execution)
4. Post-execution flow (PR creation if `auto_pr` is set)
5. Status update in `tasks.yaml` (`completed`, `failed`, or `exceeded`)

When a workflow reaches `max_steps`, the default `takt run` behavior stops the task with `exceeded` status and saves retry metadata such as `exceeded_max_steps`, `exceeded_current_iteration`, and `resume_point`. Passing `--ignore-exceed` makes `takt run` ignore only that iteration limit, continue the workflow, and skip writing exceeded retry metadata.

MCP clients can enqueue tasks, inspect task/run state, and send additional instructions to running clone tasks. Use `takt run` to execute pending tasks or `takt watch` for continuous monitoring and execution.

### Parallel Execution (Concurrency)

Both `takt run` and `takt watch` use the same worker pool and run sequentially by default (`concurrency: 1`). Configure parallel execution in `~/.takt/config.yaml`:

```yaml
concurrency: 3              # Concurrent tasks in takt run / takt watch (1-10)
task_poll_interval_ms: 500   # Task polling in takt run / takt watch (100-5000ms)
```

When concurrency is greater than 1, TAKT uses a worker pool that:

- Runs up to N tasks simultaneously
- Polls for newly added tasks at the configured interval
- Picks up new tasks as workers become available
- Displays color-coded prefixed output per task for readability
- Supports graceful shutdown on Ctrl+C (waits for in-flight tasks to complete)

### Interrupted Task Cleanup

If `takt run` is interrupted (e.g., process crash, Ctrl+C), tasks left in `running` status are automatically marked as `failed` on the next `takt run` or `takt watch` invocation. Requeue them explicitly to run them again.

### Automatic Requeue

When `auto_requeue_max_attempts` is set, `takt run` and `takt watch` requeue eligible failed workflow tasks once at startup and after execution failures, up to the saved attempt limit. Watch does not repeat the startup scan while resident; after SIGINT, it neither claims nor requeues tasks. Both commands pause task claims while waiting for user input. The default is `0` (manual requeue only). See the [Configuration Guide](./configuration.md) for details.

## Watching Tasks (`takt watch`)

Run a resident process that monitors `.takt/tasks.yaml` and auto-executes tasks as they appear:

```bash
takt watch

# Ignore workflow max_steps and continue until another stop condition occurs
takt watch --ignore-exceed
```

The watch command:

- Stays running until Ctrl+C (SIGINT)
- Monitors `tasks.yaml` for new `pending` tasks
- Executes arriving tasks up to the configured `concurrency`
- Keeps waiting when the queue is empty, using `task_poll_interval_ms` (default: 500ms)
- Marks interrupted `running` tasks as `failed` on startup
- Stops claiming tasks on SIGINT and waits for all in-flight tasks to finish without interrupting them
- Exits without a task summary, run notification sound, or Slack run summary

This is useful for a "producer-consumer" workflow where you add tasks with `takt add` in one terminal and let `takt watch` execute them automatically in another.

## Managing Task Branches (`takt list`)

List and manage task branches interactively:

```bash
takt list
```

The list view shows all tasks organized by status (pending, running, completed, failed, exceeded, pr_failed) with creation dates and summaries. Selecting a task shows available actions depending on its status. The bottom of the list also has an **All Delete** entry that deletes all tasks at once.

### Actions for Completed Tasks

| Action | Description |
|--------|-------------|
| **View diff** | Show full diff against the default branch in a pager |
| **Instruct** | Open an AI conversation to craft additional instructions, then re-execute |
| **Create PR** | Commit, push, and create a pull request from the task branch |
| **Merge from root** | Merge the root branch HEAD into the task branch; conflicts are auto-resolved with AI |
| **Pull from remote** | Pull the latest changes from remote origin (fast-forward only) |
| **Try merge** | Squash merge (stages changes without committing, for manual review) |
| **Merge & cleanup** | Squash merge and delete the branch |
| **Delete** | Discard all changes and delete the branch |

### Actions for Failed Tasks

| Action | Description |
|--------|-------------|
| **Requeue** | Select a resume or restart position and return the task to `pending` without a conversation |
| **Retry** | Open a retry conversation with failure context, review the revised instruction, then queue it as `pending` |
| **Instruct** | Open an AI conversation against the run's working tree to craft additional instructions, then requeue |
| **Create PR** | Commit, push, and create a pull request from the failed run's changes |
| **Delete** | Remove the failed task record |

In CLI/TUI assistant and grill-me conversations, `/requeue [guidance]` resolves a failed task and start position from the conversation, shows the task name, summary, workflow, and start position, then asks for Y/n. Approval returns the task to `pending` without changing its `order.md`. `/retry [guidance]` resolves a failed task from the conversation and shows a complete revised order with **Save task** and **Continue** choices. **Save task** archives the previous order and returns the task to `pending`; **Continue** makes no task changes and returns to the conversation. Inline text is guidance for resolving the conversation, not a task name. Ambiguous targets and an empty candidate set return a notice without confirmation. Neither command starts a worker; both require an interactive terminal. Persona conversations and the Web UI treat these strings as ordinary messages. The direct-run `/retry` flow in `takt resume` remains separate.

### Actions for Pending Tasks

| Action | Description |
|--------|-------------|
| **Delete** | Remove the pending task from `tasks.yaml` |

### Actions for Running Tasks

| Action | Description |
|--------|-------------|
| **Mark as failed** | Mark a stuck `running` task as `failed` |

Selecting a running task with a worktree clone opens the ordinary assistant conversation with that task as the initial `/tell` target. The conversation can inspect other tasks or discuss a new task. `/tell` rechecks the selected task after confirmation and writes only to that task; completed, missing, mismatched, and non-clone runs are not candidates or recipients.

### Actions for Exceeded Tasks

| Action | Description |
|--------|-------------|
| **Requeue** | Return the task to `pending`, resuming from where it stopped |
| **Delete** | Remove the task permanently |

`/requeue` can also target an exceeded task. It confirms the task and its stopped position, then returns it to `pending` while preserving the existing resume information. It does not offer a start-position choice or start a worker.

### Actions for PR-Failed Tasks

Tasks with `pr_failed` status (workflow succeeded but PR creation or push failed) show the publishing error and offer the same actions as completed tasks, including **Create PR**. The workflow result, local branch, and commit are preserved. A failed push skips automatic PR creation and reports the branch, commit, and retry action.

TAKT-managed remote pushes disable Git's HTTPS terminal and askpass prompts, and Git Credential Manager interaction. Configure authentication before retrying, for example with `gh auth login` and `gh auth setup-git`, or your credential helper. Custom credential helpers and SSH authentication must also be configured for unattended use.

After fixing authentication or the reported push error, tasks that need a PR can use **Create PR** in `takt list`. It commits any remaining changes, pushes the branch, and reuses an existing PR for that branch or creates one without rerunning the workflow. A successful retry changes `pr_failed` to `completed`, records the PR URL, and clears the publishing error. Cancelled or failed retries preserve `pr_failed` and the local results.

If saving the task state fails after publishing the PR, TAKT displays the published PR URL and the save error. Check the task in `takt list`; if it is still `pr_failed`, retry **Create PR**. The retry reuses the existing PR and saves the task state again.

For tasks that only push without creating a PR, fix authentication and manually push the reported branch to `origin` from the project repository. This manual push does not update the task status.

### Instruct Mode

When you select **Instruct** on a completed task, TAKT opens an interactive conversation loop with the AI. The conversation is pre-loaded with:

- Branch context (diff stat against default branch, commit history)
- Previous run session data (step logs, reports)
- Workflow structure and step previews
- Previous order content

You can discuss what additional changes are needed, and the AI helps refine the instructions. When ready, use `/go`; after the instruction is generated, choose:

- **Save as Task** -- Requeue the task as `pending` with the new instructions for later execution
- **Continue editing** -- Keep refining the instructions in the conversation

To re-execute immediately, use `/accept` (use the latest assistant response) or `/replay` (resubmit the previous order). Use `/cancel` to discard and return to the list.

**Instruct** on a failed task uses the same conversation, targeting the run's uncommitted working tree instead of a committed branch. Its conversation is additionally pre-loaded with a summary of the final adjudication report (fulfilled requirements, unresolved findings, unverified gates) and an overview of the working-tree diff.

### Retry Mode

When you select **Retry** on a failed task, TAKT:

1. Displays failure details (failed step, error message, last agent message)
2. Prompts you to select a workflow
3. Prompts you to choose a start position from a single tree
4. Opens a retry conversation pre-loaded with failure context, run session data, and workflow structure
5. Lets you refine instructions with AI assistance

**Requeue** uses the same workflow and start-position selection, but saves the task as `pending` without opening a conversation. The start-position prompt presents the workflow as a tree: when a valid resume position exists, the top row is **Resume failed position** (continue from the failure point, preserving execution state), and every authored step is listed below as a selectable leaf. `workflow_call` sub-workflows appear as non-selectable headings that indent their child steps, so you always confirm a leaf step — a sub-workflow itself cannot be chosen. When a valid Resume position is available, the Resume row is initially selected; otherwise the preferred selectable leaf for the failed root step is initially selected. Choosing any leaf restarts a new execution from that step.

The Resume row uses a short label such as `Resume failed position: "review" (default)` with a dimmed path description directly below it. The path starts with the root workflow, groups each call as `"call step" → "child workflow"`, and ends with the failed step, for example `"takt-default" > "develop" → "development-core" > "review"`. At 80 columns or wider, the description wraps to show the full path. At 60 columns, only the description is truncated from the end, preserving the root side, while the failed step and default marker remain visible in the label. The Web UI dropdown and the `Selected start position: …` confirmation log include both the label and the full path.

After a requeue, execution uses a new namespace, so its ledger is not inherited and starts empty.

After `/go`, the retry conversation shows the revised instruction and offers **Save as Task** first (the default) or **Continue editing**. Saving updates the existing task and returns it to `pending`; it does not start a worker immediately. `/retry`, `/replay`, and immediate execution choices are unavailable in this Retry conversation. Use `/cancel` to abort without changing the task.

### Non-Interactive Mode (`--non-interactive`)

For CI/CD scripts, use non-interactive mode:

```bash
# List all tasks as text
takt list --non-interactive

# List all tasks as JSON
takt list --non-interactive --format json

# Show diff stat for a specific branch
takt list --non-interactive --action diff --branch takt/my-branch

# Merge a specific branch
takt list --non-interactive --action merge --branch takt/my-branch

# Delete a branch (requires --yes)
takt list --non-interactive --action delete --branch takt/my-branch --yes

# Try merge (stage without commit)
takt list --non-interactive --action try --branch takt/my-branch
```

Available actions: `diff`, `sync`, `try`, `merge`, `delete`.

## Task Directory Workflow

The recommended end-to-end workflow:

1. **`takt add`** -- Create a task. A pending record is added to `.takt/tasks.yaml` and `order.md` is generated in `.takt/tasks/{slug}/`.
2. **Edit `order.md`** -- Open the generated file and add detailed specifications, reference materials, or supplementary files as needed.
3. **`takt run`** (or `takt watch`) -- Execute pending tasks from `tasks.yaml`. Each task runs through the configured workflow.
4. **Verify outputs** -- Check execution reports in `.takt/runs/{run_slug}/reports/`. The run slug is assigned per execution; find it via the `run_slug` field in `tasks.yaml` or the newest directory under `.takt/runs/`.
5. **`takt list`** -- Review results, merge successful branches, retry failures, or add further instructions.

## CodeRabbit review loop (`caccia`)

When a task creates or updates a pull request, TAKT can run the Caccia review loop afterward. The linked path is disabled by default and requires `caccia.enabled: true` in project or global configuration. Pipeline mode uses the same linked path after `--auto-pr` successfully creates a pull request.

Caccia waits for CodeRabbit, then processes only unresolved threads started by `coderabbitai`. Each iteration runs the configured workflow in a temporary clone, preserves its decision report under `.takt/runs/`, pushes successful fixes, resolves only the threads evaluated in that iteration, and waits for CodeRabbit to review the pushed commit. Human-started threads remain open. Caccia does not post pull-request comments or replies, and a linked Caccia result does not change the completed task result. Successes and iteration-limit results are logged and sent through the configured notification path.

The `wait_timeout_ms` limit applies to the initial review and each pushed commit review. An initial timeout skips linked Caccia and preserves the task result. A timeout waiting for a pushed commit review logs an error and also preserves the completed task result. The standalone `takt caccia` command exits non-zero on either timeout.

Linked progress, workflow output, results, and failures follow the parent task's display mode. Parallel tasks keep the same task prefix and color; silent mode produces no screen output. The parent waits for Caccia to finish before completing.

Run the same feature manually with `takt caccia <PR-number>`. See the [CLI reference](./cli-reference.md#takt-caccia) and [configuration reference](./configuration.md#caccia-review-loop) for command results and settings.

## Isolated Execution (Isolated Clone)

Specifying `worktree` in task configuration executes each task in an isolated clone created with `git clone`, keeping your main working directory clean.

### Configuration Options

| Setting | Description |
|---------|-------------|
| `worktree: true` | Auto-create clone under `{project}/../takt-worktrees` (or the location specified by `worktree_dir` config; falls back to `.takt/worktrees` inside the project when the parent directory is not writable) |
| `worktree: "/path/to/dir"` | Create clone at the specified path |
| `branch: "feat/xxx"` | Use specified branch (auto-generated as `takt/{timestamp}-{slug}` if omitted) |
| *(omit `worktree`)* | Execute in current directory (default) |

### How It Works

TAKT uses `git clone --reference <main-repo> --dissociate` instead of `git worktree` to create clones with an independent `.git` directory (when the reference repository is shallow, it falls back to a plain `git clone`). This is important because:

- **Independent `.git`**: Clones have their own `.git` directory, preventing agent tools from traversing `gitdir:` references back to the main repository.
- **Full isolation**: Agents work entirely within the clone directory, unaware of the main repository.

> **Note**: The YAML field name remains `worktree` for backward compatibility. Internally, it uses `git clone` instead of `git worktree`.

### Ephemeral Lifecycle

Clones follow an ephemeral lifecycle:

1. **Create** -- Clone is created before task execution
2. **Execute** -- Task runs inside the clone directory
3. **Commit & Push** -- On success, changes are auto-committed and pushed to the main repository (pushing to `origin` happens only when `auto_pr` or similar publishing options are set)
4. **Preserve** -- Clone is preserved after execution (for instruct/retry operations)
5. **Cleanup** -- Branches are the persistent artifacts; use `takt list` to merge or delete

### Dual Working Directory

During worktree execution, TAKT maintains two directory references:

| Directory | Purpose |
|-----------|---------|
| `cwd` (clone path) | Where agents run, where reports are written |
| `projectCwd` (project root) | Where logs and session data are stored |

Reports are written to `cwd/.takt/runs/{slug}/reports/` (inside the clone) to prevent agents from discovering the main repository path. Session resume is skipped when `cwd !== projectCwd` to avoid cross-directory contamination.

## Session Logs

TAKT writes session logs in NDJSON (Newline-Delimited JSON, `.jsonl`) format. Each record is atomically appended, so partial logs are preserved even if the process crashes.

### Log Location

```text
.takt/runs/{slug}/
  logs/{sessionId}.jsonl   # NDJSON session log per workflow execution
  meta.json                # Run metadata (task, workflow, start/end, status, etc.)
  operations/
    journal.json           # Operation journal (internal execution records)
  context/
    previous_responses/
      latest.md            # Latest previous response (inherited automatically)
```

When observability is enabled, `meta.json` also includes `observability.traceDiscovery` with the Tempo TraceQL queries that TAKT printed after completion or abort.

### Record Types

| Record Type | Description |
|-------------|-------------|
| `workflow_start` | Workflow initialization with task and workflow name |
| `step_start` | Step execution start |
| `step_complete` | Step result with status, content, matched rule info |
| `workflow_complete` | Successful workflow completion |
| `workflow_abort` | Abort with reason |

### Real-Time Monitoring

You can monitor logs in real-time during execution:

```bash
tail -f .takt/runs/{slug}/logs/{sessionId}.jsonl
```
