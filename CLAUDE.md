# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAKT (Task Agent Koordination Tool) is a multi-agent orchestration system for Claude Code. It enables YAML-based workflow definitions that coordinate multiple AI agents through state machine transitions with rule-based routing.

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
| `takt /switch` | `/sw` | Switch workflow interactively |
| `takt /clear` | | Clear agent conversation sessions (reset state) |
| `takt /eject` | | Copy builtin workflow/agents to `~/.takt/` for customization |
| `takt /refresh-builtin` | | Update builtin resources from `resources/` to `~/.takt/` |
| `takt /help` | | Show help message |
| `takt /config` | | Display current configuration |

GitHub issue references: `takt #6` fetches issue #6 and executes it as a task.

## Architecture

### Core Flow

```
CLI (cli.ts)
  → Slash commands or executeTask()
    → WorkflowEngine (workflow/engine.ts)
      → Per step: 3-phase execution
        Phase 1: runAgent() → main work
        Phase 2: runReportPhase() → report output (if step.report defined)
        Phase 3: runStatusJudgmentPhase() → status tag output (if tag-based rules)
      → detectMatchedRule() → rule evaluation → determineNextStep()
      → Parallel steps: Promise.all() for sub-steps, aggregate evaluation
```

### Three-Phase Step Execution

Each step executes in up to 3 phases (session is resumed across phases):

| Phase | Purpose | Tools | When |
|-------|---------|-------|------|
| Phase 1 | Main work (coding, review, etc.) | Step's allowed_tools (Write excluded if report defined) | Always |
| Phase 2 | Report output | Write only | When `step.report` is defined |
| Phase 3 | Status judgment | None (judgment only) | When step has tag-based rules |

Phase 2/3 are implemented in `src/workflow/phase-runner.ts`. The session is resumed so the agent retains context from Phase 1.

### Rule Evaluation (5-Stage Fallback)

After step execution, rules are evaluated to determine the next step. Evaluation order (first match wins):

1. **Aggregate** (`all()`/`any()`) - For parallel parent steps
2. **Phase 3 tag** - `[STEP:N]` tag from status judgment output
3. **Phase 1 tag** - `[STEP:N]` tag from main execution output (fallback)
4. **AI judge (ai() only)** - AI evaluates `ai("condition text")` rules
5. **AI judge fallback** - AI evaluates ALL conditions as final resort

Implemented in `src/workflow/rule-evaluator.ts`. The matched method is tracked as `RuleMatchMethod` type.

### Key Components

**WorkflowEngine** (`src/workflow/engine.ts`)
- State machine that orchestrates agent execution via EventEmitter
- Manages step transitions based on rule evaluation results
- Emits events: `step:start`, `step:complete`, `step:blocked`, `step:loop_detected`, `workflow:complete`, `workflow:abort`, `iteration:limit`
- Supports loop detection (`LoopDetector`) and iteration limits
- Maintains agent sessions per step for conversation continuity
- Parallel step execution via `runParallelStep()` with `Promise.all()`

**Instruction Builder** (`src/workflow/instruction-builder.ts`)
- Auto-injects standard sections into every instruction (no need for `{task}` or `{previous_response}` placeholders in templates):
  1. Execution context (working dir, edit permission rules)
  2. Workflow context (iteration counts, report dir)
  3. User request (`{task}` — auto-injected unless placeholder present)
  4. Previous response (auto-injected if `pass_previous_response: true`)
  5. User inputs (auto-injected unless `{user_inputs}` placeholder present)
  6. `instruction_template` content
  7. Status output rules (auto-injected for tag-based rules)
- Localized for `en` and `ja`

**Agent Runner** (`src/agents/runner.ts`)
- Resolves agent specs (name or path) to agent configurations
- Built-in agents with default tools:
  - `coder`: Read/Glob/Grep/Edit/Write/Bash/WebSearch/WebFetch
  - `architect`: Read/Glob/Grep/WebSearch/WebFetch
  - `supervisor`: Read/Glob/Grep/Bash/WebSearch/WebFetch
  - `planner`: Read/Glob/Grep/Bash/WebSearch/WebFetch
- Custom agents via `.takt/agents.yaml` or prompt files (.md)

**Claude Integration** (`src/claude/`)
- `client.ts` - High-level API: `callClaude()`, `callClaudeCustom()`, `callClaudeAgent()`, `callClaudeSkill()`
- `process.ts` - SDK wrapper with `ClaudeProcess` class
- `executor.ts` - Query execution using `@anthropic-ai/claude-agent-sdk`
- `query-manager.ts` - Concurrent query tracking with query IDs

**Configuration** (`src/config/`)
- `loader.ts` - Custom agent loading from `.takt/agents.yaml`
- `workflowLoader.ts` - YAML workflow parsing with Zod validation; resolves user workflows (`~/.takt/workflows/`) with builtin fallback (`resources/global/{lang}/workflows/`)
- `agentLoader.ts` - Agent prompt file loading
- `paths.ts` - Directory structure (`.takt/`, `~/.takt/`), session management

**Task Management** (`src/task/`)
- `runner.ts` - TaskRunner class for managing task files (`.takt/tasks/`)
- `watcher.ts` - TaskWatcher class for polling and auto-executing tasks (used by `/watch`)
- `index.ts` - Task operations (getNextTask, completeTask, addTask)

**GitHub Integration** (`src/github/issue.ts`)
- Fetches issues via `gh` CLI, formats as task text with title/body/labels/comments

### Data Flow

1. User provides task (text or `#N` issue reference) or slash command → CLI
2. CLI loads workflow: user `~/.takt/workflows/` → builtin `resources/global/{lang}/workflows/` fallback
3. WorkflowEngine starts at `initial_step`
4. Each step: `buildInstruction()` → Phase 1 (main) → Phase 2 (report) → Phase 3 (status) → `detectMatchedRule()` → `determineNextStep()`
5. Rule evaluation determines next step name
6. Special transitions: `COMPLETE` ends workflow successfully, `ABORT` ends with failure

## Directory Structure

```
~/.takt/                  # Global user config (created on first run)
  config.yaml             # Trusted dirs, default workflow, log level, language
  workflows/              # User workflow YAML files (override builtins)
  agents/                 # User agent prompt files (.md)

.takt/                    # Project-level config
  agents.yaml             # Custom agent definitions
  tasks/                  # Task files for /run-tasks
  reports/                # Execution reports (auto-generated)
  logs/                   # Session logs in NDJSON format (gitignored)

resources/                # Bundled defaults (builtin, read from dist/ at runtime)
  global/
    en/                   # English agents and workflows
    ja/                   # Japanese agents and workflows
```

Builtin resources are embedded in the npm package (`dist/resources/`). User files in `~/.takt/` take priority. Use `/eject` to copy builtins to `~/.takt/` for customization.

## Workflow YAML Schema

```yaml
name: workflow-name
description: Optional description
max_iterations: 10
initial_step: plan        # First step to execute

steps:
  # Normal step
  - name: step-name
    agent: ../agents/default/coder.md   # Path to agent prompt
    agent_name: coder                   # Display name (optional)
    provider: codex                     # claude|codex (optional)
    model: opus                         # Model name (optional)
    edit: true                          # Whether step can edit files
    permission_mode: acceptEdits        # Tool permission mode (optional)
    instruction_template: |
      Custom instructions for this step.
      {task}, {previous_response} are auto-injected if not present as placeholders.
    pass_previous_response: true        # Default: true
    report:
      name: 01-plan.md                 # Report file name
      format: |                         # Report format template
        # Plan Report
        ...
    rules:
      - condition: "Human-readable condition"
        next: next-step-name
      - condition: ai("AI evaluates this condition text")
        next: other-step
      - condition: blocked
        next: ABORT

  # Parallel step (sub-steps execute concurrently)
  - name: reviewers
    parallel:
      - name: arch-review
        agent: ../agents/default/architecture-reviewer.md
        rules:
          - condition: approved       # next is optional for sub-steps
          - condition: needs_fix
        instruction_template: |
          Review architecture...
      - name: security-review
        agent: ../agents/default/security-reviewer.md
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review security...
    rules:                            # Parent rules use aggregate conditions
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix
```

Key points about parallel steps:
- Sub-step `rules` define possible outcomes but `next` is ignored (parent handles routing)
- Parent `rules` use `all("X")`/`any("X")` to aggregate sub-step results
- `all("X")`: true if ALL sub-steps matched condition X
- `any("X")`: true if ANY sub-step matched condition X

### Rule Condition Types

| Type | Syntax | Evaluation |
|------|--------|------------|
| Tag-based | `"condition text"` | Agent outputs `[STEP:N]` tag, matched by index |
| AI judge | `ai("condition text")` | AI evaluates condition against agent output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-step matched conditions |

### Template Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Workflow-wide iteration count |
| `{max_iterations}` | Maximum iterations allowed |
| `{step_iteration}` | Per-step iteration count |
| `{previous_response}` | Previous step output (auto-injected if not in template) |
| `{user_inputs}` | Accumulated user inputs (auto-injected if not in template) |
| `{report_dir}` | Report directory name |

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

## NDJSON Session Logging

Session logs use NDJSON (`.jsonl`) format for real-time append-only writes. Record types:

| Record | Description |
|--------|-------------|
| `workflow_start` | Workflow initialization with task, workflow name |
| `step_start` | Step execution start |
| `step_complete` | Step result with status, content, matched rule info |
| `workflow_complete` | Successful completion |
| `workflow_abort` | Abort with reason |

Files: `.takt/logs/{sessionId}.jsonl`, with `latest.json` pointer. Legacy `.json` format is still readable via `loadSessionLog()`.

## TypeScript Notes

- ESM modules with `.js` extensions in imports
- Strict TypeScript with `noUncheckedIndexedAccess`
- Zod schemas for runtime validation (`src/models/schemas.ts`)
- Uses `@anthropic-ai/claude-agent-sdk` for Claude integration

## Design Principles

**Keep commands minimal.** One command per concept. Use arguments/modes instead of multiple similar commands. Before adding a new command, consider if existing commands can be extended.

**Do NOT expand schemas carelessly.** Rule conditions are free-form text (not enum-restricted). However, the engine's behavior depends on specific patterns (`ai()`, `all()`, `any()`). Do not add new special syntax without updating the loader's regex parsing in `workflowLoader.ts`.

**Instruction auto-injection over explicit placeholders.** The instruction builder auto-injects `{task}`, `{previous_response}`, `{user_inputs}`, and status rules. Templates should contain only step-specific instructions, not boilerplate.

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
