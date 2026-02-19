[日本語](./task-management.ja.md)

# Task Management

## Overview

TAKT provides a task management workflow for accumulating multiple tasks and executing them in batch. The basic flow is:

1. **`takt add`** -- Refine task requirements through AI conversation and save to `.takt/tasks.yaml`
2. **Tasks accumulate** -- Edit `order.md` files, attach reference materials
3. **`takt run`** -- Execute all pending tasks at once (sequential or parallel)
4. **`takt list`** -- Review results, merge branches, retry failures, or add instructions

Each task executes in an isolated shared clone (optional), produces reports, and creates a branch that can be merged or discarded via `takt list`.

## Adding Tasks (`takt add`)

Use `takt add` to create a new task entry in `.takt/tasks.yaml`.

```bash
# Add a task with inline text
takt add "Implement user authentication"

# Add a task from a GitHub Issue
takt add #28
```

When adding a task, you are prompted for:

- **Piece** -- Which piece (workflow) to use for execution
- **Worktree path** -- Where to create the isolated clone (Enter for auto, or specify a path)
- **Branch name** -- Custom branch name (Enter for auto-generated `takt/{timestamp}-{slug}`)
- **Auto-PR** -- Whether to automatically create a pull request after successful execution

### GitHub Issue Integration

When you pass an issue reference (e.g., `#28`), TAKT fetches the issue title, body, labels, and comments via the GitHub CLI (`gh`) and uses them as the task content. The issue number is recorded in `tasks.yaml` and reflected in the branch name.

**Requirement:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

### Saving Tasks from Interactive Mode

You can also save tasks from interactive mode. After refining requirements through conversation, use `/save` (or the save action when prompted) to persist the task to `tasks.yaml` instead of executing immediately.

## Task Directory Format

TAKT stores task metadata in `.takt/tasks.yaml` and each task's detailed specification in `.takt/tasks/{slug}/`.

### `tasks.yaml` Schema

```yaml
tasks:
  - name: add-auth-feature
    status: pending
    task_dir: .takt/tasks/20260201-015714-foptng
    piece: default
    created_at: "2026-02-01T01:57:14.000Z"
    started_at: null
    completed_at: null
```

Fields:

| Field | Description |
|-------|-------------|
| `name` | AI-generated task slug |
| `status` | `pending`, `running`, `completed`, or `failed` |
| `task_dir` | Path to the task directory containing `order.md` |
| `piece` | Piece name to use for execution |
| `worktree` | `true` (auto), a path string, or omitted (run in current directory) |
| `branch` | Branch name (auto-generated if omitted) |
| `auto_pr` | Whether to auto-create a PR after execution |
| `issue` | GitHub Issue number (if applicable) |
| `created_at` | ISO 8601 timestamp |
| `started_at` | ISO 8601 timestamp (set when execution begins) |
| `completed_at` | ISO 8601 timestamp (set when execution finishes) |

### Task Directory Layout

```text
.takt/
  tasks/
    20260201-015714-foptng/
      order.md          # Task specification (auto-generated, editable)
      schema.sql        # Attached reference materials (optional)
      wireframe.png     # Attached reference materials (optional)
  tasks.yaml            # Task metadata records
  runs/
    20260201-015714-foptng/
      reports/           # Execution reports (auto-generated)
      logs/              # NDJSON session logs
      context/           # Snapshots (previous_responses, etc.)
      meta.json          # Run metadata
```

`takt add` creates `.takt/tasks/{slug}/order.md` automatically and saves the `task_dir` reference to `tasks.yaml`. You can freely edit `order.md` and add supplementary files (SQL schemas, wireframes, API specs, etc.) to the task directory before execution.

## Executing Tasks (`takt run`)

Execute all pending tasks from `.takt/tasks.yaml`:

```bash
takt run
```

The `run` command claims pending tasks and executes them through the configured piece. Each task goes through:

1. Clone creation (if `worktree` is set)
2. Piece execution in the clone/project directory
3. Auto-commit and push (if worktree execution)
4. Post-execution flow (PR creation if `auto_pr` is set)
5. Status update in `tasks.yaml` (`completed` or `failed`)

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

### Interrupted Task Recovery

If `takt run` is interrupted (e.g., process crash, Ctrl+C), tasks left in `running` status are automatically recovered to `pending` on the next `takt run` or `takt watch` invocation.

## Watching Tasks (`takt watch`)

Run a resident process that monitors `.takt/tasks.yaml` and auto-executes tasks as they appear:

```bash
takt watch
```

The watch command:

- Stays running until Ctrl+C (SIGINT)
- Monitors `tasks.yaml` for new `pending` tasks
- Executes each task as it appears
- Recovers interrupted `running` tasks on startup
- Displays a summary of total/success/failed tasks on exit

This is useful for a "producer-consumer" workflow where you add tasks with `takt add` in one terminal and let `takt watch` execute them automatically in another.

## Managing Task Branches (`takt list`)

List and manage task branches interactively:

```bash
takt list
```

The list view shows all tasks organized by status (pending, running, completed, failed) with creation dates and summaries. Selecting a task shows available actions depending on its status.

### Actions for Completed Tasks

| Action | Description |
|--------|-------------|
| **View diff** | Show full diff against the default branch in a pager |
| **Instruct** | Open an AI conversation to craft additional instructions, then re-execute |
| **Try merge** | Squash merge (stages changes without committing, for manual review) |
| **Merge & cleanup** | Squash merge and delete the branch |
| **Delete** | Discard all changes and delete the branch |

### Actions for Failed Tasks

| Action | Description |
|--------|-------------|
| **Retry** | Open a retry conversation with failure context, then re-execute |
| **Delete** | Remove the failed task record |

### Actions for Pending Tasks

| Action | Description |
|--------|-------------|
| **Delete** | Remove the pending task from `tasks.yaml` |

### Instruct Mode

When you select **Instruct** on a completed task, TAKT opens an interactive conversation loop with the AI. The conversation is pre-loaded with:

- Branch context (diff stat against default branch, commit history)
- Previous run session data (movement logs, reports)
- Piece structure and movement previews
- Previous order content

You can discuss what additional changes are needed, and the AI helps refine the instructions. When ready, choose:

- **Execute** -- Re-execute the task immediately with the new instructions
- **Save task** -- Requeue the task as `pending` with the new instructions for later execution
- **Cancel** -- Discard and return to the list

### Retry Mode

When you select **Retry** on a failed task, TAKT:

1. Displays failure details (failed movement, error message, last agent message)
2. Prompts you to select a piece
3. Prompts you to select which movement to start from (defaults to the failed movement)
4. Opens a retry conversation pre-loaded with failure context, run session data, and piece structure
5. Lets you refine instructions with AI assistance

The retry conversation supports the same actions as Instruct mode (execute, save task, cancel). Retry notes are appended to the task record, accumulating across multiple retry attempts.

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

Available actions: `diff`, `try`, `merge`, `delete`.

## Task Directory Workflow

The recommended end-to-end workflow:

1. **`takt add`** -- Create a task. A pending record is added to `.takt/tasks.yaml` and `order.md` is generated in `.takt/tasks/{slug}/`.
2. **Edit `order.md`** -- Open the generated file and add detailed specifications, reference materials, or supplementary files as needed.
3. **`takt run`** (or `takt watch`) -- Execute pending tasks from `tasks.yaml`. Each task runs through the configured piece workflow.
4. **Verify outputs** -- Check execution reports in `.takt/runs/{slug}/reports/` (the slug matches the task directory).
5. **`takt list`** -- Review results, merge successful branches, retry failures, or add further instructions.

## Isolated Execution (Shared Clone)

Specifying `worktree` in task configuration executes each task in an isolated clone created with `git clone --shared`, keeping your main working directory clean.

### Configuration Options

| Setting | Description |
|---------|-------------|
| `worktree: true` | Auto-create shared clone in adjacent directory (or location specified by `worktree_dir` config) |
| `worktree: "/path/to/dir"` | Create clone at the specified path |
| `branch: "feat/xxx"` | Use specified branch (auto-generated as `takt/{timestamp}-{slug}` if omitted) |
| *(omit `worktree`)* | Execute in current directory (default) |

### How It Works

TAKT uses `git clone --shared` instead of `git worktree` to create lightweight clones with an independent `.git` directory. This is important because:

- **Independent `.git`**: Shared clones have their own `.git` directory, preventing agent tools (like Claude Code) from traversing `gitdir:` references back to the main repository.
- **Full isolation**: Agents work entirely within the clone directory, unaware of the main repository.

> **Note**: The YAML field name remains `worktree` for backward compatibility. Internally, it uses `git clone --shared` instead of `git worktree`.

### Ephemeral Lifecycle

Clones follow an ephemeral lifecycle:

1. **Create** -- Clone is created before task execution
2. **Execute** -- Task runs inside the clone directory
3. **Commit & Push** -- On success, changes are auto-committed and pushed to the branch
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
  logs/{sessionId}.jsonl   # NDJSON session log per piece execution
  meta.json                # Run metadata (task, piece, start/end, status, etc.)
  context/
    previous_responses/
      latest.md            # Latest previous response (inherited automatically)
```

### Record Types

| Record Type | Description |
|-------------|-------------|
| `piece_start` | Piece initialization with task and piece name |
| `step_start` | Movement execution start |
| `step_complete` | Movement result with status, content, matched rule info |
| `piece_complete` | Successful piece completion |
| `piece_abort` | Abort with reason |

### Real-Time Monitoring

You can monitor logs in real-time during execution:

```bash
tail -f .takt/runs/{slug}/logs/{sessionId}.jsonl
```
