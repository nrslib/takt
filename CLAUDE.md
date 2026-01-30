# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAKT (Task Agent Koordination Tool) is a multi-agent orchestration system for Claude Code. It enables YAML-based workflow definitions that coordinate multiple AI agents through state machine transitions.

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript build |
| `npm run test` | Run all tests |
| `npm run test:watch` | Watch mode |
| `npm run lint` | ESLint |
| `npx vitest run src/__tests__/client.test.ts` | Run single test file |
| `npx vitest run -t "pattern"` | Run tests matching pattern |

## CLI Slash Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `takt /run-tasks` | `/run` | Execute all pending tasks from `.takt/tasks/` once |
| `takt /watch` | | Watch `.takt/tasks/` and auto-execute tasks (resident process) |
| `takt /add-task` | `/add` | Add a new task interactively (YAML format, multiline supported) |
| `takt /list-tasks` | `/list` | List task branches (try merge, merge & cleanup, or delete) |
| `takt /switch` | | Switch workflow interactively |
| `takt /clear` | | Clear agent conversation sessions (reset state) |
| `takt /refresh-builtin` | | Update builtin resources from `resources/` to `~/.takt/` |
| `takt /help` | | Show help message |
| `takt /config` | | Display current configuration |

## Architecture

### Core Flow

```
CLI (cli.ts)
  → Slash commands (/run-tasks, /watch, /add-task, /list-tasks, /switch, /clear, /refresh-builtin, /help, /config)
  → or executeTask()
    → WorkflowEngine (workflow/engine.ts)
      → runAgent() (agents/runner.ts)
        → callClaude() (claude/client.ts)
          → executeClaudeCli() (claude/process.ts)
            → ClaudeProcess (claude-agent-sdk)
```

### Key Components

**WorkflowEngine** (`src/workflow/engine.ts`)
- State machine that orchestrates agent execution via EventEmitter
- Manages step transitions based on agent response status
- Emits events: `step:start`, `step:complete`, `step:blocked`, `step:loop_detected`, `workflow:complete`, `workflow:abort`, `iteration:limit`
- Supports loop detection (`LoopDetector`) and iteration limits
- Maintains agent sessions per step for conversation continuity

**Agent Runner** (`src/agents/runner.ts`)
- Resolves agent specs (name or path) to agent configurations
- Built-in agents with default tools:
  - `coder`: Read/Glob/Grep/Edit/Write/Bash/WebSearch/WebFetch
  - `architect`: Read/Glob/Grep/WebSearch/WebFetch
  - `supervisor`: Read/Glob/Grep/Bash/WebSearch/WebFetch
  - `planner`: Read/Glob/Grep/Bash/WebSearch/WebFetch
- Custom agents via `.takt/agents.yaml` or prompt files (.md)
- Supports Claude Code agents (`claudeAgent`) and skills (`claudeSkill`)

**Claude Integration** (`src/claude/`)
- `client.ts` - High-level API: `callClaude()`, `callClaudeCustom()`, `callClaudeAgent()`, `callClaudeSkill()`, status detection via regex patterns
- `process.ts` - SDK wrapper with `ClaudeProcess` class, re-exports query management
- `executor.ts` - Query execution using `@anthropic-ai/claude-agent-sdk`
- `query-manager.ts` - Concurrent query tracking with query IDs

**Configuration** (`src/config/`)
- `loader.ts` - Custom agent loading from `.takt/agents.yaml`
- `workflowLoader.ts` - YAML workflow parsing with Zod validation (loads from `~/.takt/workflows/` only)
- `agentLoader.ts` - Agent prompt file loading
- `paths.ts` - Directory structure (`.takt/`, `~/.takt/`), session management

**Task Management** (`src/task/`)
- `runner.ts` - TaskRunner class for managing task files (`.takt/tasks/`)
- `watcher.ts` - TaskWatcher class for polling and auto-executing tasks (used by `/watch`)
- `index.ts` - Task operations (getNextTask, completeTask, addTask)

### Data Flow

1. User provides task or slash command → CLI
2. CLI loads workflow from `~/.takt/workflows/{name}.yaml`
3. WorkflowEngine starts at `initialStep`
4. Each step: `buildInstruction()` → `runStep()` → `runAgent()` → `callClaude()` → detect status → `determineNextStep()`
5. Status patterns (regex in `statusPatterns`) determine next step via `transitions`
6. Special transitions: `COMPLETE` ends workflow successfully, `ABORT` ends with failure

### Status Detection

Agents output status markers (e.g., `[CODER:DONE]`) that are matched against `GENERIC_STATUS_PATTERNS` in `src/models/schemas.ts`. Common statuses: `done`, `blocked`, `approved`, `rejected`, `improve`, `in_progress`, `interrupted`.

## Directory Structure

```
~/.takt/                  # Global user config (created on first run)
  config.yaml             # Trusted dirs, default workflow, log level, language
  workflows/              # Workflow YAML files (required location)
  agents/                 # Agent prompt files (.md)

.takt/                    # Project-level config
  agents.yaml             # Custom agent definitions
  tasks/                  # Task files for /run-tasks
  reports/                # Execution reports (auto-generated)
  logs/                   # Session logs (gitignored)

resources/                # Bundled defaults (copied to ~/.takt on init)
  global/
    en/                   # English agents and workflows
    ja/                   # Japanese agents and workflows
```

## Workflow YAML Schema

```yaml
name: workflow-name
description: Optional description
max_iterations: 10        # snake_case in YAML

steps:
  - name: step-name
    agent: ~/.takt/agents/default/coder.md  # Path to agent prompt
    agent_name: coder                       # Display name (optional)
    provider: codex                         # claude|codex (optional)
    model: opus                             # Model name (optional)
    instruction_template: |
      {task}
      {previous_response}
    pass_previous_response: true            # Default: true
    transitions:
      - condition: done
        next_step: next-step
      - condition: blocked
        next_step: ABORT
    on_no_status: complete    # complete|continue|stay
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request |
| `{iteration}` | Current iteration number |
| `{max_iterations}` | Maximum iterations |
| `{previous_response}` | Previous step output (requires `pass_previous_response: true`) |
| `{user_inputs}` | Accumulated user inputs during workflow |
| `{report_dir}` | Report directory name (e.g., `20250126-143052-task-summary`) |

### Model Resolution

Model is resolved in the following priority order:

1. **Workflow step `model`** - Highest priority (specified in step YAML)
2. **Custom agent `model`** - Agent-level model in `.takt/agents.yaml`
3. **Global config `model`** - Default model in `~/.takt/config.yaml`
4. **Provider default** - Falls back to provider's default (Claude: sonnet, Codex: gpt-5.2-codex)

Example `~/.takt/config.yaml`:
```yaml
provider: claude
model: opus          # Default model for all steps (unless overridden)
```

## TypeScript Notes

- ESM modules with `.js` extensions in imports
- Strict TypeScript with `noUncheckedIndexedAccess`
- Zod schemas (v4 syntax) for runtime validation (`src/models/schemas.ts`)
- Uses `@anthropic-ai/claude-agent-sdk` for Claude integration

## Design Principles

**Keep commands minimal.** One command per concept. Use arguments/modes instead of multiple similar commands. Before adding a new command, consider if existing commands can be extended.

**Do NOT expand schemas carelessly.** The `TransitionConditionSchema` defines allowed condition values for workflow transitions. Do NOT add new values without strong justification. Use existing values creatively:
- `done` - Task completed (minor fixes, successful completion)
- `blocked` - Cannot proceed (needs plan rework)
- `approved` - Review passed
- `rejected` - Review failed, needs major rework
- `improve` - Needs improvement (security concerns, quality issues)
- `always` - Unconditional transition

## Isolated Execution (Shared Clone)

When tasks specify `worktree: true` or `worktree: "path"`, code runs in a `git clone --shared` (lightweight clone with independent `.git` directory). Clones are ephemeral: created before task execution, auto-committed + pushed after success, then deleted.

> **Why `worktree` in YAML but `git clone --shared` internally?** The YAML field name `worktree` is retained for backward compatibility. The original implementation used `git worktree`, but git worktrees have a `.git` file containing `gitdir: /path/to/main/.git/worktrees/...`. Claude Code follows this path and recognizes the main repository as the project root, causing agents to work on main instead of the worktree. `git clone --shared` creates an independent `.git` directory that prevents this traversal.

Key constraints:

- **Independent `.git`**: Shared clones have their own `.git` directory, preventing Claude Code from traversing `gitdir:` back to the main repository.
- **Ephemeral lifecycle**: Clone is created → task runs → auto-commit + push → clone is deleted. Branches are the single source of truth.
- **Session isolation**: Claude Code sessions are stored per-cwd in `~/.claude/projects/{encoded-path}/`. Sessions from the main project cannot be resumed in a clone. The engine skips session resume when `cwd !== projectCwd`.
- **No node_modules**: Clones only contain tracked files. `node_modules/` is absent.
- **Dual cwd**: `cwd` = clone path (where agents run), `projectCwd` = project root (where `.takt/` lives). Reports, logs, and session data always write to `projectCwd`.
- **List**: Use `takt /list-tasks` to list branches. Instruct action creates a temporary clone for the branch, executes, pushes, then removes the clone.

## Error Propagation

`ClaudeResult` (from SDK) has an `error` field. This must be propagated through `AgentResponse.error` → session log history → console output. Without this, SDK failures (exit code 1, rate limits, auth errors) appear as empty `blocked` status with no diagnostic info.

## Testing Notes

- Vitest for testing framework
- Tests use file system fixtures in `__tests__/` subdirectories
- Mock workflows and agent configs for integration tests
- Test single files: `npx vitest run src/__tests__/filename.test.ts`
- Pattern matching: `npx vitest run -t "test pattern"`
