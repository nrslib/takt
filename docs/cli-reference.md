# CLI Reference

[日本語](./cli-reference.ja.md)

This document provides a complete reference for all TAKT CLI commands and options.

## Global Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode -- required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--pr <number>` | PR number to fetch review comments and fix |
| `--auto-pr` | Create PR after execution (pipeline mode only) |
| `--draft` | Create PR as draft (requires `--auto-pr` or `auto_pr` config) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, workflow-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude-sdk\|claude\|codex\|opencode\|cursor\|copilot\|mock) |
| `--model <name>` | Override agent model |
| `--config <path>` | Path to global config file (default: `~/.takt/config.yaml`) |

`--workflow` is the canonical option.

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

1. Select workflow
2. Select interactive mode (assistant / persona / quiet / passthrough)
3. Refine task content through conversation with AI
4. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`), or use `/play <task>` to execute a task immediately
5. Execute (run workflow, create PR)

### Interactive Mode Variants

| Mode | Description |
|------|-------------|
| `assistant` | Default. AI asks clarifying questions before generating task instructions. |
| `persona` | Conversation with the first step's persona (uses its system prompt and tools). |
| `quiet` | Generates task instructions without asking questions (best-effort). |
| `passthrough` | Passes user input directly as task text without AI processing. |

Workflows can set a default mode via the `interactive_mode` field in YAML.

### Execution Example

```
$ takt

Select workflow:
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

[Workflow execution starts...]
```

## Direct Task Execution

Use the `--task` option to skip interactive mode and execute directly.

```bash
# Specify task content with --task option
takt --task "Fix bug"

# Specify workflow
takt --task "Add authentication" --workflow dual
```

**Note:** Passing a string as an argument (e.g., `takt "Add login feature"`) enters interactive mode with it as the initial message.

## GitHub Issue Tasks

You can execute GitHub Issues directly as tasks. Issue title, body, labels, and comments are automatically incorporated as task content.

```bash
# Execute by specifying issue number
takt #6
takt --issue 6

# Issue + workflow specification
takt #6 --workflow dual
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

List task branches and perform actions (merge, delete, merge from root, etc.).

```bash
# List task branches (merge/delete)
takt list

# Non-interactive mode (for CI/scripts)
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

In interactive mode, **Merge from root** merges the root repository HEAD into the worktree branch with AI-assisted conflict resolution.

### Task Directory Workflow (Create / Run / Verify)

1. Run `takt add` and confirm a pending record is created in `.takt/tasks.yaml`.
2. Open the generated `.takt/tasks/{slug}/order.md` and add detailed specifications/references as needed.
3. Run `takt run` (or `takt watch`) to execute pending tasks from `tasks.yaml`.
4. Verify outputs in `.takt/runs/{slug}/reports/` using the same slug as `task_dir`.

## Pipeline Mode

Specifying `--pipeline` enables non-interactive pipeline mode. Automatically creates branch, runs the workflow, commits and pushes. Suitable for CI/CD automation.

```bash
# Execute task in pipeline mode
takt --pipeline --task "Fix bug"

# Pipeline execution + auto-create PR
takt --pipeline --task "Fix bug" --auto-pr

# Link issue information
takt --pipeline --issue 99 --auto-pr

# Specify workflow and branch
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# Specify repository (for PR creation)
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# Workflow execution only (skip branch creation, commit, push)
takt --pipeline --task "Fix bug" --skip-git

# Minimal output mode (for CI)
takt --pipeline --task "Fix bug" --quiet
```

In pipeline mode, PRs are not created unless `--auto-pr` is specified.

**GitHub Integration:** When using TAKT in GitHub Actions, see [takt-action](https://github.com/nrslib/takt-action). You can automate PR reviews and task execution.

## Utility Commands

### Interactive workflow selection

Run `takt` without a task argument to choose a workflow interactively.

```bash
takt
```

### takt eject

Copy builtin workflows/personas to your local directory for customization.

```bash
# Copy builtin workflows/personas to project .takt/ for customization
takt eject

# Copy to ~/.takt/ (global) instead
takt eject --global

# Eject a specific facet for customization
takt eject persona coder
takt eject instruction plan --global
```

Builtin and custom workflow lookup uses `workflows/`.

### takt workflow

Initialize and validate custom workflow definitions.

```bash
# Create a minimal workflow scaffold in project .takt/workflows/
takt workflow init sample-flow

# Create a faceted scaffold in ~/.takt/workflows/
takt workflow init review-flow --template faceted --global

# Validate workflows by name or path
takt workflow doctor sample-flow
takt workflow doctor .takt/workflows/sample-flow.yaml
```

### takt clear

Clear agent conversation sessions (reset state).

```bash
takt clear
```

### takt export-cc

Deploy builtin workflows/personas as a Claude Code Skill.

```bash
takt export-cc
```

### takt export-codex

Deploy TAKT skill files as a Codex Skill (`~/.agents/skills/takt/`).
This command deploys `SKILL.md`, `references/`, `agents/`, `workflows/`, and `facets/`.

```bash
takt export-codex
```

### takt catalog

List available facets across layers.

```bash
takt catalog
takt catalog personas
```

### takt prompt

Preview assembled prompts for each step and phase.

```bash
takt prompt [workflow]
```

### takt reset

Reset settings to defaults.

```bash
# Reset global config to builtin template (with backup)
takt reset config

# Reset workflow categories to builtin defaults
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

### takt repertoire

Manage repertoire packages (external TAKT packages from GitHub).

```bash
# Install a package from GitHub
takt repertoire add github:{owner}/{repo}@{ref}

# Install from default branch
takt repertoire add github:{owner}/{repo}

# List installed packages
takt repertoire list

# Remove a package
takt repertoire remove @{owner}/{repo}
```

Installed packages are stored in `~/.takt/repertoire/` and their workflows/facets become available in workflow selection and facet resolution.

When the same workflow name exists in multiple locations, TAKT resolves in this order: `.takt/workflows/` → `~/.takt/workflows/` → builtins.

### takt purge

Purge old analytics event files.

```bash
# Purge files older than 30 days (default)
takt purge

# Specify retention period
takt purge --retention-days 14
```
