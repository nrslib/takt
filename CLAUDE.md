# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAKT (TAKT Agent Koordination Topology) is a multi-agent orchestration system for Claude Code. It enables YAML-based workflow definitions that coordinate multiple AI agents through state machine transitions with rule-based routing.

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript build (also copies prompt .md, i18n .yaml, and preset .sh files to dist/) |
| `npm run watch` | TypeScript build in watch mode |
| `npm run test` | Run all unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | ESLint |
| `npx vitest run src/__tests__/client.test.ts` | Run single test file |
| `npx vitest run -t "pattern"` | Run tests matching pattern |
| `npm run test:e2e` | Run E2E tests with mock provider (includes GitHub connectivity check) |
| `npm run test:e2e:mock` | Run E2E tests with mock provider (direct, no connectivity check) |
| `npm run test:e2e:provider:claude` | Run E2E tests against Claude provider |
| `npm run test:e2e:provider:codex` | Run E2E tests against Codex provider |
| `npm run test:e2e:provider:opencode` | Run E2E tests against OpenCode provider |
| `npm run check:release` | Full release check (build + lint + test + e2e) with macOS notification |

## CLI Subcommands

| Command | Description |
|---------|-------------|
| `takt {task}` | Execute task with current workflow |
| `takt` | Interactive task input mode (chat with AI to refine requirements) |
| `takt run` | Execute all pending tasks from `.takt/tasks/` once |
| `takt watch` | Watch `.takt/tasks/` and auto-execute tasks (resident process) |
| `takt add [task]` | Add a new task via AI conversation |
| `takt list` | List task branches (merge, delete, retry) |
| `takt clear` | Clear agent conversation sessions (reset state) |
| `takt eject [type] [name]` | Copy builtin workflow or facet for customization (`--global` for ~/.takt/) |
| `takt prompt [workflow]` | Preview assembled prompts for each step and phase |
| `takt catalog [type]` | List available facets (personas, policies, knowledge, etc.) |
| `takt workflow init <name>` | Initialize a new workflow scaffold |
| `takt workflow doctor [targets]` | Validate workflow definitions |
| `takt export-cc` | Export takt workflows/agents as Claude Code Skill (~/.claude/) |
| `takt export-codex` | Export takt skill files to Codex Skill (~/.agents/skills/takt/) |
| `takt reset config` | Reset global config to builtin template |
| `takt reset categories` | Reset workflow categories to builtin defaults |
| `takt metrics review` | Show review quality metrics |
| `takt purge` | Purge old analytics event files |
| `takt repertoire add <spec>` | Install a repertoire package from GitHub |
| `takt repertoire remove <scope>` | Remove an installed repertoire package |
| `takt repertoire list` | List installed repertoire packages |
| `takt config` | Configure settings (permission mode) |

**Interactive mode:** Running `takt` (without arguments) or `takt {initial message}` starts an interactive planning session. Supports 4 modes: `assistant` (default), `passthrough`, `quiet`, `persona`. Type `/go` to execute, `/cancel` to abort. Implemented in `src/features/interactive/`.

**Pipeline mode:** `--pipeline` enables non-interactive mode for CI/CD. Auto-creates a branch, runs the workflow, commits, and pushes. `--auto-pr` to also create a PR. `--skip-git` for workflow-only execution. Implemented in `src/features/pipeline/`.

**GitHub issue references:** `takt #6` fetches issue #6 and executes it as a task.

### CLI Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode |
| `-t, --task <text>` | Task content (as alternative to GitHub issue) |
| `-i, --issue <N>` | GitHub issue number (equivalent to `#N`) |
| `--pr <number>` | PR number to fetch review comments and fix |
| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |
| `-b, --branch <name>` | Branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR after execution (pipeline mode only) |
| `--draft` | Create PR as draft (requires --auto-pr) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode) |
| `--repo <owner/repo>` | Repository for PR creation |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `-c, --continue` | Continue from the last assistant session |
| `--provider <name>` | Override agent provider (claude-sdk\|claude\|codex\|opencode\|cursor\|copilot\|mock) |
| `--model <name>` | Override agent model |

## Architecture

### Core Flow

```
CLI (cli.ts → routing.ts)
  → Interactive mode / Pipeline mode / Direct task execution
    → WorkflowEngine (core/workflow/engine/WorkflowEngine.ts)
      → Per step, delegates to one of 4 runners:
        StepExecutor     — Normal steps (3-phase execution)
        ParallelRunner   — Parallel sub-steps via Promise.allSettled()
        ArpeggioRunner   — Data-driven batch processing (CSV → template → LLM)
        TeamLeaderRunner — Dynamic task decomposition into sub-parts
      → detectMatchedRule() → rule evaluation → determineNextStepByRules()
```

### Three-Phase Step Execution

Each normal step executes in up to 3 phases (session is resumed across phases):

| Phase | Purpose | Tools | When |
|-------|---------|-------|------|
| Phase 1 | Main work (coding, review, etc.) | Step's allowed_tools (Write excluded if report defined) | Always |
| Phase 2 | Report output | Write only | When `output_contracts` is defined |
| Phase 3 | Status judgment | None (judgment only) | When step has tag-based rules |

Phase 2/3 are implemented in `src/core/workflow/phase-runner.ts`. The session is resumed so the agent retains context from Phase 1.

### Rule Evaluation (5-Stage Fallback)

After step execution, rules are evaluated to determine the next step. Evaluation order (first match wins):

1. **Aggregate** (`all()`/`any()`) — For parallel parent steps
2. **Phase 3 tag** — `[STEP:N]` tag from status judgment output
3. **Phase 1 tag** — `[STEP:N]` tag from main execution output (fallback)
4. **AI judge (ai() only)** — AI evaluates `ai("condition text")` rules
5. **AI judge fallback** — AI evaluates ALL conditions as final resort

Implemented in `src/core/workflow/evaluation/RuleEvaluator.ts`. The matched method is tracked as `RuleMatchMethod` type (`aggregate`, `auto_select`, `structured_output`, `phase3_tag`, `phase1_tag`, `ai_judge`, `ai_judge_fallback`).

### Key Components

**WorkflowEngine** (`src/core/workflow/engine/WorkflowEngine.ts`)
- State machine that orchestrates agent execution via EventEmitter
- Manages step transitions based on rule evaluation results
- Emits events: `step:start`, `step:complete`, `step:blocked`, `step:report`, `step:user_input`, `step:loop_detected`, `step:cycle_detected`, `phase:start`, `phase:complete`, `workflow:complete`, `workflow:abort`, `iteration:limit`
- Delegates to `StepExecutor` (normal), `ParallelRunner` (parallel), `ArpeggioRunner` (data-driven batch), `TeamLeaderRunner` (task decomposition)
- Loop detection (`LoopDetector`), cycle detection (`CycleDetector`), and iteration limits

**StepExecutor** (`src/core/workflow/engine/StepExecutor.ts`)
- Executes a single workflow step through the 3-phase model
- Builds instructions via `InstructionBuilder`, detects matched rules via `RuleEvaluator`

**RuleEvaluator** (`src/core/workflow/evaluation/RuleEvaluator.ts`)
- 5-stage fallback evaluation: aggregate → Phase 3 tag → Phase 1 tag → ai() judge → all-conditions AI judge
- Returns `RuleMatch` with index and detection method
- Fail-fast: throws if rules exist but no rule matched
- Tag detection uses **last match** when multiple `[STEP:N]` tags appear

**InstructionBuilder** (`src/core/workflow/instruction/InstructionBuilder.ts`)
- Auto-injects standard sections into every instruction: execution context, workflow context, user request (`{task}`), previous response, user inputs, instruction content, status output rules
- Templates should contain only step-specific instructions, not boilerplate

**Provider Integration** (`src/infra/providers/`)
- Unified `Provider` interface: `setup(AgentSetup) → ProviderAgent`, `ProviderAgent.call(prompt, options) → AgentResponse`
- **ProviderRegistry** singleton with 7 providers:
  - `claude-sdk` — Uses `@anthropic-ai/claude-agent-sdk` (SDK integration)
  - `claude` — Headless CLI mode (`src/infra/claude-headless/`)
  - `codex` — Uses `@openai/codex-sdk`, retry with exponential backoff
  - `opencode` — Uses `@opencode-ai/sdk/v2`, shared server pooling
  - `cursor` — Cursor agent integration (`src/infra/cursor/`)
  - `copilot` — GitHub Copilot integration (`src/infra/copilot/`)
  - `mock` — Deterministic responses for testing

**Configuration** (`src/infra/config/`)
- `loaders/workflowParser.ts` — YAML parsing, step/rule normalization with Zod validation
- `loaders/workflowResolver.ts` — **3-layer resolution**: project `.takt/workflows/` → user `~/.takt/workflows/` → builtin `builtins/{lang}/workflows/`. Also supports repertoire packages `@{owner}/{repo}/{workflow-name}`
- `paths.ts` — Directory structure (`.takt/`, `~/.takt/`), session management
- `global/globalConfig.ts` — Global configuration (provider, model, language, quiet mode)
- `project/projectConfig.ts` — Project-level configuration

**VCS Integration** (`src/infra/git/`, `src/infra/github/`, `src/infra/gitlab/`)
- Common `GitProvider` interface with auto-detection from git remote URL
- GitHub via `gh` CLI, GitLab via `glab` CLI
- Configurable via `vcs_provider` in project/global config

### Data Flow

1. User provides task (text or `#N` issue reference) → CLI
2. CLI loads workflow with **priority**: project `.takt/workflows/` → user `~/.takt/workflows/` → builtin `builtins/{lang}/workflows/`
3. WorkflowEngine starts at `initial_step`
4. Each step: delegate to appropriate runner → 3-phase execution → `detectMatchedRule()` → `determineNextStepByRules()`
5. Rule evaluation determines next step name (uses **last match** when multiple `[STEP:N]` tags appear)
6. Special transitions: `COMPLETE` ends workflow successfully, `ABORT` ends with failure

## Directory Structure

```
~/.takt/                    # Global user config
  config.yaml               # Language, provider, model, log level, etc.
  workflows/                # User workflow YAML files (override builtins)
  facets/                   # User facets (personas/, policies/, knowledge/, instructions/, output-contracts/)
  repertoire/               # Installed repertoire packages (@{owner}/{repo}/)

.takt/                      # Project-level config
  config.yaml               # Project configuration
  workflows/                # Project workflow YAML files (highest priority)
  facets/                   # Project-level facets
  tasks/                    # Task files for takt run
  runs/                     # Execution reports (runs/{slug}/reports/)
  logs/                     # Session logs in NDJSON format (gitignored)
  events/                   # Analytics event files (NDJSON)

builtins/                   # Bundled defaults (read from dist/ at runtime)
  en/                       # English (facets/, workflows/)
  ja/                       # Japanese (same structure)
  project/                  # Project-level template files
  skill/                    # Claude Code skill files
  skill-codex/              # Codex skill files
```

## Workflow YAML Schema

```yaml
name: workflow-name
description: Optional description
max_steps: 10
initial_step: plan       # First step to execute
interactive_mode: assistant  # Default interactive mode (assistant|passthrough|quiet|persona)

workflow_config:
  provider_options:
    codex: { network_access: true }
    opencode: { network_access: true }
    claude: { sandbox: { allow_unsandboxed_commands: true } }
  runtime:
    prepare: [node, gradle, ./custom-script.sh]

loop_monitors:
  - cycle: [review, fix]
    threshold: 3
    judge:
      persona: supervisor
      instruction: "Evaluate if the fix loop is making progress..."
      rules:
        - condition: "Progress is being made"
          next: fix
        - condition: "No progress"
          next: ABORT

# Section maps (key → file path relative to workflow YAML directory)
personas:
  coder: ../facets/personas/coder.md
policies:
  coding: ../facets/policies/coding.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
instructions:
  plan: ../facets/instructions/plan.md
report_formats:
  plan: ../facets/output-contracts/plan.md

steps:
  # Normal step
  - name: step-name
    persona: coder                      # Persona key (references section map)
    persona_name: coder                 # Display name (optional)
    session: continue                   # continue (default) | refresh
    policy: coding                      # Policy key (single or array)
    knowledge: architecture             # Knowledge key (single or array)
    instruction: plan                   # Instruction key (references section map)
    provider: claude                    # claude-sdk|claude|codex|opencode|cursor|copilot|mock (optional)
    model: opus                         # Model name (optional)
    edit: true                          # Whether step can edit files
    required_permission_mode: edit      # Minimum permission mode (optional)
    quality_gates:                      # AI directives for completion (optional)
      - "All tests pass"
    provider_options:                   # Per-provider options (optional)
      codex: { network_access: true }
      claude: { sandbox: { excluded_commands: [rm] } }
    mcp_servers:                        # MCP server configuration (optional)
      my-server:
        command: npx
        args: [-y, my-mcp-server]
    instruction: |
      Custom instructions for this step.
    pass_previous_response: true        # Default: true
    output_contracts:
      report:
        - name: 01-plan.md
          format: plan
          order: "Write the plan to {report_dir}/01-plan.md"
    rules:
      - condition: "Human-readable condition"
        next: next-step-name
      - condition: ai("AI evaluates this condition text")
        next: other-step
      - condition: blocked
        next: ABORT
        requires_user_input: true

  # Parallel step (sub-steps execute concurrently)
  - name: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
        persona: security-reviewer
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-security
    rules:
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix

  # Arpeggio step (data-driven batch processing)
  - name: batch-process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data/items.csv
      batch_size: 5
      concurrency: 3
      template: ./templates/process.txt
      max_retries: 2
      retry_delay_ms: 1000
      merge:
        strategy: concat
        separator: "\n---\n"
      output_path: ./output/result.txt
    rules:
      - condition: "Processing complete"
        next: COMPLETE

  # Team leader step (dynamic task decomposition)
  - name: implement
    team_leader:
      max_parts: 3
      timeout_ms: 600000
      part_persona: coder
      part_edit: true
      part_permission_mode: edit
      part_allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
    instruction: |
      Decompose this task into independent subtasks.
    rules:
      - condition: "All parts completed"
        next: review
```

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
| `{max_steps}` | Maximum steps allowed |
| `{step_iteration}` | Per-step iteration count |
| `{previous_response}` | Previous step output (auto-injected if not in template) |
| `{user_inputs}` | Accumulated user inputs (auto-injected if not in template) |
| `{report_dir}` | Report directory name |

## Design Principles

**Do NOT expand schemas carelessly.** Rule conditions are free-form text. The engine's behavior depends on specific regex patterns (`ai()`, `all()`, `any()`). Do not add new special syntax without updating the rule normalizer's regex parsing in `workflowRuleNormalizer.ts`.

**Instruction auto-injection over explicit placeholders.** The instruction builder auto-injects `{task}`, `{previous_response}`, `{user_inputs}`, and status rules. Templates should contain only step-specific instructions.

**Faceted prompting: each facet has a dedicated file type.**

```
builtins/{lang}/facets/
  personas/     — WHO: identity, expertise, behavioral habits
  policies/     — HOW: judgment criteria, REJECT/APPROVE rules, prohibited patterns
  knowledge/    — WHAT TO KNOW: domain patterns, anti-patterns, detailed reasoning with examples
  instructions/ — WHAT TO DO NOW: step-specific procedures and checklists
```

| Deciding where to place content | Facet |
|--------------------------------|-------|
| Role definition, AI habit prevention | Persona |
| Actionable REJECT/APPROVE criterion | Policy |
| Detailed reasoning, examples | Knowledge |
| This-step-only procedure or checklist | Instruction |
| Workflow structure, facet assignment | Workflow YAML |

Key rules:
- Persona files are reusable across workflows. Never include workflow-specific procedures
- Policy REJECT lists are what reviewers enforce. Knowledge alone does not trigger enforcement
- Instructions are bound to a single workflow step

**Separation of concerns in workflow engine:**
- `WorkflowEngine` — Orchestration, state management, event emission
- `StepExecutor` — Single step execution (3-phase model)
- `ParallelRunner` — Parallel step execution
- `ArpeggioRunner` — Data-driven batch processing
- `TeamLeaderRunner` — Dynamic task decomposition
- `RuleEvaluator` — Rule matching and evaluation
- `InstructionBuilder` — Instruction template processing

**Session management:** Agent sessions are stored per-cwd in `~/.claude/projects/{encoded-path}/` (Claude) or in-memory (Codex/OpenCode). Sessions are resumed across phases (Phase 1 → Phase 2 → Phase 3). Session key format: `{persona}:{provider}`. When `cwd !== projectCwd` (clone execution), session resume is skipped.

## Isolated Execution (Shared Clone)

When tasks specify `worktree: true`, code runs in a `git clone --shared` (lightweight clone with independent `.git`). Clones are ephemeral: created before task execution, auto-committed + pushed after success, then deleted.

> The YAML field name `worktree` is retained for backward compatibility. The implementation uses `git clone --shared` because git worktrees have a `.git` file with `gitdir:` that causes Claude Code to follow the path back to the main repository.

Key constraints:
- **Independent `.git`**: Shared clones prevent Claude Code from traversing back to main repo
- **Ephemeral lifecycle**: Clone → task → auto-commit + push → delete
- **Session isolation**: Sessions cannot be resumed in a clone (`cwd !== projectCwd`)
- **No node_modules**: Clones only contain tracked files
- **Dual cwd**: `cwd` = clone path, `projectCwd` = project root. Reports write to `cwd/.takt/runs/{slug}/reports/`

## Important Implementation Notes

**Model resolution priority order:**
1. Persona-level `model` — `persona_providers.<persona>.model`
2. Step `model` — workflow step field
3. CLI/task override `model` — `--model`
4. Local/Global config `model` — `.takt/config.yaml` / `~/.takt/config.yaml` when provider matches
5. Provider default

**Permission modes** (provider-independent):
- `readonly` — No file modifications
- `edit` — Allow file edits with confirmation
- `full` — Bypass all permission checks
- Step-level `required_permission_mode` sets the minimum floor

**Loop detection — two mechanisms:**
- `LoopDetector` — Consecutive same-step executions (configurable max, default 10)
- `CycleDetector` — Cyclic patterns between steps (e.g., review → fix → review). Configured via `loop_monitors` with threshold + judge

**Rule evaluation quirks:**
- Tag-based rules match by array index (0-based), not by exact condition text
- When multiple `[STEP:N]` tags appear, **last match wins**
- `ai()` conditions are evaluated by the provider, not string matching
- Aggregate conditions (`all()`, `any()`) only work in parallel parent steps
- Fail-fast: if rules exist but no rule matches, workflow aborts

**Error propagation:** Provider errors must propagate through `AgentResponse.error` → session log → console output. Without this, SDK failures appear as empty `blocked` status.

## TypeScript Notes

- ESM modules with `.js` extensions in imports
- Strict TypeScript with `noUncheckedIndexedAccess`
- Zod v4 schemas for runtime validation (`src/core/models/schemas.ts`)
- Vitest for testing (single-thread, 15s timeout, 5s teardown)
- Unit tests: `src/__tests__/*.test.ts` (352 files)
- E2E mock tests: `e2e/specs/*.e2e.ts` via `vitest.config.e2e.mock.ts` (240s timeout)
- Environment variables cleared in test setup: `TAKT_CONFIG_DIR`, `TAKT_NOTIFY_WEBHOOK`

## Debugging

Set `logging.debug: true` in `~/.takt/config.yaml` for debug logs to `.takt/runs/debug-{timestamp}/logs/`. Set `verbose: true` or `TAKT_VERBOSE=true` for verbose console output. Session logs at `.takt/logs/{sessionId}.jsonl`. Use `--provider mock` for testing without real AI APIs.
