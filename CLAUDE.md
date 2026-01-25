# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAKT (Task Agent Koordination Tool) is a multi-agent orchestration system for Claude Code and Codex. It enables YAML-based workflow definitions that coordinate multiple AI agents through state machine transitions.

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript build |
| `npm run test` | Run all tests |
| `npm run test:watch` | Watch mode |
| `npm run lint` | ESLint |
| `npx vitest run src/__tests__/client.test.ts` | Run single test file |
| `npx vitest run -t "pattern"` | Run tests matching pattern |

## Architecture

### Core Flow

```
CLI (cli.ts)
  → Slash commands (/run-tasks, /switch, /clear, /help)
  → or executeTask()
    → WorkflowEngine (workflow/engine.ts)
      → runAgent() (agents/runner.ts)
        → callClaude() (claude/client.ts)
          → executeClaudeQuery() (claude/executor.ts via claude/process.ts)
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
- Built-in agents with default tools: `coder` (Read/Glob/Grep/Edit/Write/Bash/WebSearch/WebFetch), `architect` (Read/Glob/Grep/WebSearch/WebFetch), `supervisor` (Read/Glob/Grep/Bash/WebSearch/WebFetch)
- Custom agents via `.takt/agents.yaml` or prompt files (.md)
- Supports Claude Code agents (`claudeAgent`) and skills (`claudeSkill`)

**Claude Integration** (`src/claude/`)
- `client.ts` - High-level API: `callClaude()`, `callClaudeCustom()`, `callClaudeAgent()`, `callClaudeSkill()`, status detection via regex patterns
- `process.ts` - SDK wrapper with `ClaudeProcess` class, re-exports query management
- `executor.ts` - Query execution using `@anthropic-ai/claude-agent-sdk`
- `query-manager.ts` - Concurrent query tracking with query IDs

**Configuration** (`src/config/`)
- `loader.ts` - Custom agent loading from `.takt/agents.yaml`
- `workflowLoader.ts` - YAML workflow parsing with Zod validation
- `agentLoader.ts` - Agent prompt file loading
- `paths.ts` - Directory structure (`.takt/`, `~/.takt/`), session management

### Data Flow

1. User provides task or slash command → CLI
2. CLI loads workflow from `.takt/workflow.yaml` (or named workflow)
3. WorkflowEngine starts at `initialStep`
4. Each step: `buildInstruction()` → `runStep()` → `runAgent()` → `callClaude()` → detect status → `determineNextStep()`
5. Status patterns (regex in `statusPatterns`) determine next step via `transitions`
6. Special transitions: `COMPLETE` ends workflow successfully, `ABORT` ends with failure

### Status Detection

Agents output status markers (e.g., `[CODER:DONE]`) that are matched against `statusPatterns` in `src/models/schemas.ts`. Common statuses: `done`, `blocked`, `approved`, `rejected`, `in_progress`, `interrupted`.

## Project Structure

```
.takt/                    # Project config (logs/ is gitignored)
  workflow.yaml           # Default workflow definition
  workflows/              # Named workflow files
  agents.yaml             # Custom agent definitions
  agents/                 # Agent prompt files (.md)
  prompts/                # Shared prompts
  logs/                   # Session logs

~/.takt/                  # Global config
  config.yaml             # Trusted dirs, default workflow, log level
  workflows/              # Global workflow files
```

## Workflow YAML Schema

```yaml
name: workflow-name
max_iterations: 10        # Note: snake_case in YAML
initial_step: first-step

steps:
  - name: step-name
    agent: coder              # Built-in agent name
    # or agent_path: ./agents/custom.md  # Custom prompt file
    instruction_template: |
      {task}
      {previous_output}
    transitions:
      - condition: done
        next_step: next-step
      - condition: blocked
        next_step: ABORT
    on_no_status: complete    # complete|continue|stay
```

## TypeScript Notes

- ESM modules with `.js` extensions in imports
- Strict TypeScript with `noUncheckedIndexedAccess`
- Zod schemas for runtime validation (`src/models/schemas.ts`)
- Uses `@anthropic-ai/claude-agent-sdk` for Claude integration
- Simple CLI prompts in `src/prompt/` for user interaction

## Command Design Principles

**Keep commands minimal.** Avoid proliferating commands. One command per concept.

- Use a single command with arguments/modes instead of multiple similar commands
- Example: `/config` opens permission mode selection. No need for `/sacrifice`, `/safe`, `/confirm`, etc.
- Before adding a new command, consider if existing commands can be extended
