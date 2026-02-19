# CLI Reference

[日本語](./cli-reference.ja.md)

This document provides a complete reference for all TAKT CLI commands and options.

## Global Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode -- required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --piece <name or path>` | Piece name or path to piece YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, piece-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `--create-worktree <yes\|no>` | Skip worktree confirmation prompt |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|codex\|opencode\|mock) |
| `--model <name>` | Override agent model |
| `--config <path>` | Path to global config file (default: `~/.takt/config.yaml`) |

## Interactive Mode

A mode where you refine task content through conversation with AI before execution. Useful when task requirements are ambiguous or when you want to clarify content while consulting with AI.

```bash
# Start interactive mode (no arguments)
takt

# Specify initial message (short word only)
takt hello
```

**Note:** `--task` option skips interactive mode and executes the task directly. Issue references (`#6`, `--issue`) are used as initial input in interactive mode.

### Flow

1. Select piece
2. Select interactive mode (assistant / persona / quiet / passthrough)
3. Refine task content through conversation with AI
4. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`), or use `/play <task>` to execute a task immediately
5. Execute (create worktree, run piece, create PR)

### Interactive Mode Variants

| Mode | Description |
|------|-------------|
| `assistant` | Default. AI asks clarifying questions before generating task instructions. |
| `persona` | Conversation with the first movement's persona (uses its system prompt and tools). |
| `quiet` | Generates task instructions without asking questions (best-effort). |
| `passthrough` | Passes user input directly as task text without AI processing. |

Pieces can set a default mode via the `interactive_mode` field in YAML.

### Execution Example

```
$ takt

Select piece:
  > default (current)
    Development/
    Research/
    Cancel

Interactive mode - Enter task content. Commands: /go (execute), /cancel (exit)

> I want to add user authentication feature

[AI confirms and organizes requirements]

> /go

Proposed task instructions:
---
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
---

Proceed with these task instructions? (Y/n) y

? Create worktree? (Y/n) y

[Piece execution starts...]
```

## Direct Task Execution

Use the `--task` option to skip interactive mode and execute directly.

```bash
# Specify task content with --task option
takt --task "Fix bug"

# Specify piece
takt --task "Add authentication" --piece expert

# Auto-create PR
takt --task "Fix bug" --auto-pr
```

**Note:** Passing a string as an argument (e.g., `takt "Add login feature"`) enters interactive mode with it as the initial message.

## GitHub Issue Tasks

You can execute GitHub Issues directly as tasks. Issue title, body, labels, and comments are automatically incorporated as task content.

```bash
# Execute by specifying issue number
takt #6
takt --issue 6

# Issue + piece specification
takt #6 --piece expert

# Issue + auto-create PR
takt #6 --auto-pr
```

**Requirements:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

## Task Management Commands

Batch processing using `.takt/tasks.yaml` with task directories under `.takt/tasks/{slug}/`. Useful for accumulating multiple tasks and executing them together later.

### takt add

Refine task requirements through AI conversation, then add a task to `.takt/tasks.yaml`.

```bash
# Refine task requirements through AI conversation, then add task
takt add

# Add task from GitHub Issue (issue number reflected in branch name)
takt add #28
```

### takt run

Execute all pending tasks from `.takt/tasks.yaml`.

```bash
# Execute all pending tasks in .takt/tasks.yaml
takt run
```

### takt watch

Monitor `.takt/tasks.yaml` and auto-execute tasks as a resident process.

```bash
# Monitor .takt/tasks.yaml and auto-execute tasks (resident process)
takt watch
```

### takt list

List task branches and perform actions (merge, delete, etc.).

```bash
# List task branches (merge/delete)
takt list

# Non-interactive mode (for CI/scripts)
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

### Task Directory Workflow (Create / Run / Verify)

1. Run `takt add` and confirm a pending record is created in `.takt/tasks.yaml`.
2. Open the generated `.takt/tasks/{slug}/order.md` and add detailed specifications/references as needed.
3. Run `takt run` (or `takt watch`) to execute pending tasks from `tasks.yaml`.
4. Verify outputs in `.takt/runs/{slug}/reports/` using the same slug as `task_dir`.

## Pipeline Mode

Specifying `--pipeline` enables non-interactive pipeline mode. Automatically creates branch, runs piece, commits and pushes. Suitable for CI/CD automation.

```bash
# Execute task in pipeline mode
takt --pipeline --task "Fix bug"

# Pipeline execution + auto-create PR
takt --pipeline --task "Fix bug" --auto-pr

# Link issue information
takt --pipeline --issue 99 --auto-pr

# Specify piece and branch
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# Specify repository (for PR creation)
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# Piece execution only (skip branch creation, commit, push)
takt --pipeline --task "Fix bug" --skip-git

# Minimal output mode (for CI)
takt --pipeline --task "Fix bug" --quiet
```

In pipeline mode, PRs are not created unless `--auto-pr` is specified.

**GitHub Integration:** When using TAKT in GitHub Actions, see [takt-action](https://github.com/nrslib/takt-action). You can automate PR reviews and task execution.

## Utility Commands

### takt switch

Interactively switch the active piece.

```bash
takt switch
```

### takt eject

Copy builtin pieces/personas to your local directory for customization.

```bash
# Copy builtin pieces/personas to project .takt/ for customization
takt eject

# Copy to ~/.takt/ (global) instead
takt eject --global

# Eject a specific facet for customization
takt eject persona coder
takt eject instruction plan --global
```

### takt clear

Clear agent conversation sessions (reset state).

```bash
takt clear
```

### takt export-cc

Deploy builtin pieces/personas as a Claude Code Skill.

```bash
takt export-cc
```

### takt catalog

List available facets across layers.

```bash
takt catalog
takt catalog personas
```

### takt prompt

Preview assembled prompts for each movement and phase.

```bash
takt prompt [piece]
```

### takt reset

Reset settings to defaults.

```bash
# Reset global config to builtin template (with backup)
takt reset config

# Reset piece categories to builtin defaults
takt reset categories
```

### takt metrics

Show analytics metrics.

```bash
# Show review quality metrics (default: last 30 days)
takt metrics review

# Specify time window
takt metrics review --since 7d
```

### takt purge

Purge old analytics event files.

```bash
# Purge files older than 30 days (default)
takt purge

# Specify retention period
takt purge --retention-days 14
```
