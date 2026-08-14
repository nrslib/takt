[日本語](./task-management.ja.md)

# Task Management

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

### Saving Tasks from MCP Clients

MCP clients can use the `takt-mcp` stdio server to save pending tasks without invoking shell commands. `takt_enqueue_task` writes a pending record to `.takt/tasks.yaml`; its optional `issue` object links an existing issue or creates one through the configured TAKT issue provider. If saving fails after issue creation and the issue number was resolved, the issue remains open and the MCP error result returns its number for retry. If number extraction fails, the result can provide the issue URL instead. The tool requires an absolute `cwd` and a non-empty task body. Use `takt run` to execute pending tasks or `takt watch` to monitor and execute them continuously. See [CLI Reference](./cli-reference.md#mcp-server) for setup and tool input details.

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

MCP clients enqueue tasks only. Use `takt run` to execute pending tasks or `takt watch` for continuous monitoring and execution.

### Parallel Execution (Concurrency)

By default, tasks run sequentially (`concurrency: 1`). Configure parallel execution in `~/.takt/config.yaml`:

```yaml
concurrency: 3              # Run up to 3 tasks in parallel (1-10)
task_poll_interval_ms: 500   # Polling interval for new tasks (100-5000ms)
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

When `auto_requeue_max_attempts` is set in the configuration, failed workflow tasks are automatically requeued when `takt run` starts, up to the configured number of attempts. The default is `0` (manual requeue only). See the [Configuration Guide](./configuration.md) for details.

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
- Executes each task as it appears
- Marks interrupted `running` tasks as `failed` on startup
- Displays a summary of total/success/failed tasks on exit

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
| **Merge from root** | Merge the root branch HEAD into the task branch; conflicts are auto-resolved with AI |
| **Pull from remote** | Pull the latest changes from remote origin (fast-forward only) |
| **Try merge** | Squash merge (stages changes without committing, for manual review) |
| **Merge & cleanup** | Squash merge and delete the branch |
| **Delete** | Discard all changes and delete the branch |

### Actions for Failed Tasks

| Action | Description |
|--------|-------------|
| **Requeue** | Select a resume or restart position and return the task to `pending` without a conversation |
| **Retry** | Open a retry conversation with failure context, then re-execute |
| **Delete** | Remove the failed task record |

### Actions for Pending Tasks

| Action | Description |
|--------|-------------|
| **Delete** | Remove the pending task from `tasks.yaml` |

### Actions for Running Tasks

| Action | Description |
|--------|-------------|
| **Mark as failed** | Mark a stuck `running` task as `failed` |

### Actions for Exceeded Tasks

| Action | Description |
|--------|-------------|
| **Requeue** | Return the task to `pending`, resuming from where it stopped |
| **Delete** | Remove the task permanently |

### Actions for PR-Failed Tasks

Tasks with `pr_failed` status (workflow succeeded but PR creation or push failed) show the PR error message and offer the same actions as completed tasks.

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

### Retry Mode

When you select **Retry** on a failed task, TAKT:

1. Displays failure details (failed step, error message, last agent message)
2. Prompts you to select a workflow
3. Prompts you to choose a start position: **Resume failed position** or **Restart from**
4. Opens a retry conversation pre-loaded with failure context, run session data, and workflow structure
5. Lets you refine instructions with AI assistance

**Requeue** uses the same workflow and start-position selection, but saves the task as `pending` without opening a conversation. With Retry and Requeue you choose between **Resume** (continue from the failure point, preserving execution state) and **Restart** (start a new execution from any step of your choice). Steps nested under `workflow_call` sub-workflows can also be selected as the start position.

After a requeue, execution uses a new namespace, so its ledger is not inherited and starts empty.

After `/go`, the retry conversation offers the same choices as Instruct mode (**Save as Task** / **Continue editing**), with `/accept` and `/replay` for immediate re-execution and `/cancel` to abort. Both saving and immediate re-execution use the selected Resume or Restart position. Retry notes are appended to the task record, accumulating across multiple retry attempts.

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
