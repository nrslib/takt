# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAKT (TAKT Agent Koordination Topology) is a multi-agent orchestration system for Claude Code. It enables YAML-based piece definitions that coordinate multiple AI agents through state machine transitions with rule-based routing.

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript build |
| `npm run watch` | TypeScript build in watch mode |
| `npm run test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode (alias: `npm run test -- --watch`) |
| `npm run lint` | ESLint |
| `npx vitest run src/__tests__/client.test.ts` | Run single test file |
| `npx vitest run -t "pattern"` | Run tests matching pattern |
| `npm run prepublishOnly` | Lint, build, and test before publishing |

## CLI Subcommands

| Command | Description |
|---------|-------------|
| `takt {task}` | Execute task with current piece |
| `takt` | Interactive task input mode (chat with AI to refine requirements) |
| `takt run` | Execute all pending tasks from `.takt/tasks/` once |
| `takt watch` | Watch `.takt/tasks/` and auto-execute tasks (resident process) |
| `takt add` | Add a new task via AI conversation |
| `takt list` | List task branches (try merge, merge & cleanup, or delete) |
| `takt switch` | Switch piece interactively |
| `takt clear` | Clear agent conversation sessions (reset state) |
| `takt eject` | Copy builtin piece/agents to `~/.takt/` for customization |
| `takt config` | Configure settings (permission mode) |
| `takt --help` | Show help message |

**Interactive mode:** Running `takt` (without arguments) or `takt {initial message}` starts an interactive planning session. The AI helps refine task requirements through conversation. Type `/go` to execute the task with the selected piece, or `/cancel` to abort. Implemented in `src/features/interactive/`.

**Pipeline mode:** Specifying `--pipeline` enables non-interactive mode suitable for CI/CD. Automatically creates a branch, runs the piece, commits, and pushes. Use `--auto-pr` to also create a pull request. Use `--skip-git` to run piece only (no git operations). Implemented in `src/features/pipeline/`.

**GitHub issue references:** `takt #6` fetches issue #6 and executes it as a task.

### CLI Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode — required for CI/automation |
| `-t, --task <text>` | Task content (as alternative to GitHub issue) |
| `-i, --issue <N>` | GitHub issue number (equivalent to `#N` in interactive mode) |
| `-w, --piece <name or path>` | Piece name or path to piece YAML file (v0.3.8+) |
| `-b, --branch <name>` | Branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR after execution (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, piece-only) |
| `--repo <owner/repo>` | Repository for PR creation |
| `--create-worktree <yes\|no>` | Skip worktree confirmation prompt |
| `-q, --quiet` | **Minimal output mode: suppress AI output (for CI)** (v0.3.8+) |
| `--provider <name>` | Override agent provider (claude\|codex\|mock) (v0.3.8+) |
| `--model <name>` | Override agent model (v0.3.8+) |
| `--config <path>` | Path to global config file (default: `~/.takt/config.yaml`) (v0.3.8+) |

## Architecture

### Core Flow

```
CLI (cli.ts)
  → Slash commands or executeTask()
    → PieceEngine (piece/engine.ts)
      → Per movement: 3-phase execution
        Phase 1: runAgent() → main work
        Phase 2: runReportPhase() → report output (if output_contracts defined)
        Phase 3: runStatusJudgmentPhase() → status tag output (if tag-based rules)
      → detectMatchedRule() → rule evaluation → determineNextStep()
      → Parallel movements: Promise.all() for sub-movements, aggregate evaluation
```

### Three-Phase Movement Execution

Each movement executes in up to 3 phases (session is resumed across phases):

| Phase | Purpose | Tools | When |
|-------|---------|-------|------|
| Phase 1 | Main work (coding, review, etc.) | Movement's allowed_tools (Write excluded if report defined) | Always |
| Phase 2 | Report output | Write only | When `output_contracts` is defined |
| Phase 3 | Status judgment | None (judgment only) | When movement has tag-based rules |

Phase 2/3 are implemented in `src/core/piece/engine/phase-runner.ts`. The session is resumed so the agent retains context from Phase 1.

### Rule Evaluation (5-Stage Fallback)

After movement execution, rules are evaluated to determine the next movement. Evaluation order (first match wins):

1. **Aggregate** (`all()`/`any()`) - For parallel parent movements
2. **Phase 3 tag** - `[STEP:N]` tag from status judgment output
3. **Phase 1 tag** - `[STEP:N]` tag from main execution output (fallback)
4. **AI judge (ai() only)** - AI evaluates `ai("condition text")` rules
5. **AI judge fallback** - AI evaluates ALL conditions as final resort

Implemented in `src/core/piece/evaluation/RuleEvaluator.ts`. The matched method is tracked as `RuleMatchMethod` type.

### Key Components

**PieceEngine** (`src/core/piece/engine/PieceEngine.ts`)
- State machine that orchestrates agent execution via EventEmitter
- Manages movement transitions based on rule evaluation results
- Emits events: `step:start`, `step:complete`, `step:blocked`, `step:loop_detected`, `piece:complete`, `piece:abort`, `iteration:limit`
- Supports loop detection (`LoopDetector`) and iteration limits
- Maintains agent sessions per movement for conversation continuity
- Delegates to `StepExecutor` (normal steps) and `ParallelRunner` (parallel steps)

**StepExecutor** (`src/core/piece/engine/StepExecutor.ts`)
- Executes a single piece movement through the 3-phase model
- Phase 1: Main agent execution (with tools)
- Phase 2: Report output (Write-only, optional)
- Phase 3: Status judgment (no tools, optional)
- Builds instructions via `InstructionBuilder`, detects matched rules via `RuleEvaluator`

**ParallelRunner** (`src/core/piece/engine/ParallelRunner.ts`)
- Executes parallel sub-movements concurrently via `Promise.all()`
- Aggregates sub-movement results for parent rule evaluation
- Supports `all()` / `any()` aggregate conditions

**RuleEvaluator** (`src/core/piece/evaluation/RuleEvaluator.ts`)
- 5-stage fallback evaluation: aggregate → Phase 3 tag → Phase 1 tag → ai() judge → all-conditions AI judge
- Returns `RuleMatch` with index and detection method (`aggregate`, `phase3_tag`, `phase1_tag`, `ai_judge`, `ai_fallback`)
- Fail-fast: throws if rules exist but no rule matched
- **v0.3.8+:** Tag detection now uses **last match** instead of first match when multiple `[STEP:N]` tags appear in output

**Instruction Builder** (`src/core/piece/instruction/InstructionBuilder.ts`)
- Auto-injects standard sections into every instruction (no need for `{task}` or `{previous_response}` placeholders in templates):
  1. Execution context (working dir, edit permission rules)
  2. Piece context (iteration counts, report dir)
  3. User request (`{task}` — auto-injected unless placeholder present)
  4. Previous response (auto-injected if `pass_previous_response: true`)
  5. User inputs (auto-injected unless `{user_inputs}` placeholder present)
  6. `instruction_template` content
  7. Status output rules (auto-injected for tag-based rules)
- Localized for `en` and `ja`
- Related: `ReportInstructionBuilder` (Phase 2), `StatusJudgmentBuilder` (Phase 3)

**Agent Runner** (`src/agents/runner.ts`)
- Resolves agent specs (name or path) to agent configurations
- **v0.3.8+:** Agent is optional — movements can execute with `instruction_template` only (no system prompt)
- Built-in agents with default tools:
  - `coder`: Read/Glob/Grep/Edit/Write/Bash/WebSearch/WebFetch
  - `architect`: Read/Glob/Grep/WebSearch/WebFetch
  - `supervisor`: Read/Glob/Grep/Bash/WebSearch/WebFetch
  - `planner`: Read/Glob/Grep/Bash/WebSearch/WebFetch
- Custom agents via `.takt/agents.yaml` or prompt files (.md)
- Inline system prompts: If agent file doesn't exist, the agent string is used as inline system prompt

**Provider Integration** (`src/infra/claude/`, `src/infra/codex/`)
- **Claude** - Uses `@anthropic-ai/claude-agent-sdk`
  - `client.ts` - High-level API: `callClaude()`, `callClaudeCustom()`, `callClaudeAgent()`, `callClaudeSkill()`
  - `process.ts` - SDK wrapper with `ClaudeProcess` class
  - `executor.ts` - Query execution
  - `query-manager.ts` - Concurrent query tracking with query IDs
- **Codex** - Direct OpenAI SDK integration
  - `CodexStreamHandler.ts` - Stream handling and tool execution

**Configuration** (`src/infra/config/`)
- `loaders/loader.ts` - Custom agent loading from `.takt/agents.yaml`
- `loaders/pieceParser.ts` - YAML parsing, movement/rule normalization with Zod validation
- `loaders/pieceResolver.ts` - **3-layer resolution with correct priority** (v0.3.8+: user → project → builtin)
- `loaders/pieceCategories.ts` - Piece categorization and filtering
- `loaders/agentLoader.ts` - Agent prompt file loading
- `paths.ts` - Directory structure (`.takt/`, `~/.takt/`), session management
- `global/globalConfig.ts` - Global configuration (provider, model, trusted dirs, **quiet mode** v0.3.8+)
- `project/projectConfig.ts` - Project-level configuration

**Task Management** (`src/features/tasks/`)
- `execute/taskExecution.ts` - Main task execution orchestration
- `execute/pieceExecution.ts` - Piece execution wrapper
- `add/index.ts` - Interactive task addition via AI conversation
- `list/index.ts` - List task branches with merge/delete actions
- `watch/index.ts` - Watch for task files and auto-execute

**GitHub Integration** (`src/infra/github/`)
- `issue.ts` - Fetches issues via `gh` CLI, formats as task text with title/body/labels/comments
- `pr.ts` - Creates pull requests via `gh` CLI

### Data Flow

1. User provides task (text or `#N` issue reference) or slash command → CLI
2. CLI loads piece with **correct priority** (v0.3.8+): user `~/.takt/pieces/` → project `.takt/pieces/` → builtin `builtins/{lang}/pieces/`
3. PieceEngine starts at `initial_movement`
4. Each movement: `buildInstruction()` → Phase 1 (main) → Phase 2 (report) → Phase 3 (status) → `detectMatchedRule()` → `determineNextStep()`
5. Rule evaluation determines next movement name (v0.3.8+: uses **last match** when multiple `[STEP:N]` tags appear)
6. Special transitions: `COMPLETE` ends piece successfully, `ABORT` ends with failure

## Directory Structure

```
~/.takt/                  # Global user config (created on first run)
  config.yaml             # Trusted dirs, default piece, log level, language
  pieces/                 # User piece YAML files (override builtins)
  facets/                 # User facets
    personas/             # User persona prompt files (.md)
    policies/             # User policy files
    knowledge/            # User knowledge files
    instructions/         # User instruction files
    output-contracts/     # User output contract files
  repertoire/             # Installed repertoire packages

.takt/                    # Project-level config
  config.yaml             # Project configuration
  agents.yaml             # Custom agent definitions
  facets/                 # Project-level facets
  tasks/                  # Task files for /run-tasks
  runs/                   # Execution reports, logs, context
  logs/                   # Session logs in NDJSON format (gitignored)

builtins/                 # Bundled defaults (builtin, read from dist/ at runtime)
  en/                     # English
    facets/               # Facets (personas, policies, knowledge, instructions, output-contracts)
    pieces/               # Piece YAML files
  ja/                     # Japanese (same structure)
  project/                # Project-level template files
  skill/                  # Claude Code skill files
```

Builtin resources are embedded in the npm package (`builtins/`). User files in `~/.takt/` take priority. Use `/eject` to copy builtins to `~/.takt/` for customization.

## Piece YAML Schema

```yaml
name: piece-name
description: Optional description
max_movements: 10
initial_movement: plan    # First movement to execute

# Section maps (key → file path relative to piece YAML directory)
personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md
policies:
  coding: ../facets/policies/coding.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
instructions:
  plan: ../facets/instructions/plan.md
report_formats:
  plan: ../facets/output-contracts/plan.md

movements:
  # Normal movement
  - name: movement-name
    persona: coder                      # Persona key (references section map)
    persona_name: coder                 # Display name (optional)
    policy: coding                      # Policy key (single or array)
    knowledge: architecture             # Knowledge key (single or array)
    instruction: plan                   # Instruction key (references section map)
    provider: codex                     # claude|codex|opencode (optional)
    model: opus                         # Model name (optional)
    edit: true                          # Whether movement can edit files
    required_permission_mode: edit       # Required minimum permission mode (optional)
    instruction_template: |
      Custom instructions for this movement.
      {task}, {previous_response} are auto-injected if not present as placeholders.
    pass_previous_response: true        # Default: true
    output_contracts:
      report:
        - name: 01-plan.md             # Report file name
          format: plan                  # References report_formats map
    rules:
      - condition: "Human-readable condition"
        next: next-movement-name
      - condition: ai("AI evaluates this condition text")
        next: other-movement
      - condition: blocked
        next: ABORT

  # Parallel movement (sub-movements execute concurrently)
  - name: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        policy: review
        knowledge: architecture
        edit: false
        rules:
          - condition: approved       # next is optional for sub-movements
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
        persona: security-reviewer
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-security
    rules:                            # Parent rules use aggregate conditions
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix
```

Key points about parallel movements:
- Sub-movement `rules` define possible outcomes but `next` is ignored (parent handles routing)
- Parent `rules` use `all("X")`/`any("X")` to aggregate sub-movement results
- `all("X")`: true if ALL sub-movements matched condition X
- `any("X")`: true if ANY sub-movements matched condition X

### Rule Condition Types

| Type | Syntax | Evaluation |
|------|--------|------------|
| Tag-based | `"condition text"` | Agent outputs `[STEP:N]` tag, matched by index |
| AI judge | `ai("condition text")` | AI evaluates condition against agent output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-movement matched conditions |

### Template Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Piece-wide iteration count |
| `{max_movements}` | Maximum movements allowed |
| `{movement_iteration}` | Per-movement iteration count |
| `{previous_response}` | Previous movement output (auto-injected if not in template) |
| `{user_inputs}` | Accumulated user inputs (auto-injected if not in template) |
| `{report_dir}` | Report directory name |

### Piece Categories

Pieces can be organized into categories for better UI presentation. Categories are configured in:
- `builtins/{lang}/piece-categories.yaml` - Default builtin categories
- `~/.takt/config.yaml` - User-defined categories (via `piece_categories` field)

Category configuration supports:
- Nested categories (unlimited depth)
- Per-category piece lists
- "Others" category for uncategorized pieces (can be disabled via `show_others_category: false`)
- Builtin piece filtering (disable via `builtin_pieces_enabled: false`, or selectively via `disabled_builtins: [name1, name2]`)

Example category config:
```yaml
piece_categories:
  Development:
    pieces: [default, default-mini]
    children:
      Backend:
        pieces: [expert-cqrs]
      Frontend:
        pieces: [expert]
  Research:
    pieces: [research, magi]
show_others_category: true
others_category_name: "Other Pieces"
```

Implemented in `src/infra/config/loaders/pieceCategories.ts`.

### Model Resolution

Model is resolved in the following priority order:

1. **Piece movement `model`** - Highest priority (specified in movement YAML)
2. **Custom agent `model`** - Agent-level model in `.takt/agents.yaml`
3. **Global config `model`** - Default model in `~/.takt/config.yaml`
4. **Provider default** - Falls back to provider's default (Claude: sonnet, Codex: gpt-5.2-codex)

Example `~/.takt/config.yaml`:
```yaml
provider: claude
model: opus          # Default model for all movements (unless overridden)
```

## NDJSON Session Logging

Session logs use NDJSON (`.jsonl`) format for real-time append-only writes. Record types:

| Record | Description |
|--------|-------------|
| `piece_start` | Piece initialization with task, piece name |
| `step_start` | Step execution start |
| `step_complete` | Step result with status, content, matched rule info |
| `piece_complete` | Successful completion |
| `piece_abort` | Abort with reason |

Files: `.takt/logs/{sessionId}.jsonl`, with `latest.json` pointer. Legacy `.json` format is still readable via `loadSessionLog()`.

## TypeScript Notes

- ESM modules with `.js` extensions in imports
- Strict TypeScript with `noUncheckedIndexedAccess`
- Zod schemas for runtime validation (`src/core/models/schemas.ts`)
- Uses `@anthropic-ai/claude-agent-sdk` for Claude integration

## Design Principles

**Keep commands minimal.** One command per concept. Use arguments/modes instead of multiple similar commands. Before adding a new command, consider if existing commands can be extended.

**Do NOT expand schemas carelessly.** Rule conditions are free-form text (not enum-restricted). However, the engine's behavior depends on specific patterns (`ai()`, `all()`, `any()`). Do not add new special syntax without updating the loader's regex parsing in `pieceParser.ts`.

**Instruction auto-injection over explicit placeholders.** The instruction builder auto-injects `{task}`, `{previous_response}`, `{user_inputs}`, and status rules. Templates should contain only movement-specific instructions, not boilerplate.

**Faceted prompting: each facet has a dedicated file type.** TAKT assembles agent prompts from 4 facets. Each facet has a distinct role. When adding new rules or knowledge, place content in the correct facet.

```
builtins/{lang}/facets/
  personas/     — WHO: identity, expertise, behavioral habits
  policies/     — HOW: judgment criteria, REJECT/APPROVE rules, prohibited patterns
  knowledge/    — WHAT TO KNOW: domain patterns, anti-patterns, detailed reasoning with examples
  instructions/ — WHAT TO DO NOW: movement-specific procedures and checklists
```

| Deciding where to place content | Facet | Example |
|--------------------------------|-------|---------|
| Role definition, AI habit prevention | Persona | "置き換えたコードを残す → 禁止" |
| Actionable REJECT/APPROVE criterion | Policy | "内部実装のパブリックAPIエクスポート → REJECT" |
| Detailed reasoning, REJECT/OK table with examples | Knowledge | "パブリックAPIの公開範囲" section |
| This-movement-only procedure or checklist | Instruction | "レビュー観点: 構造・設計の妥当性..." |
| Workflow structure, facet assignment | Piece YAML | `persona: coder`, `policy: coding`, `knowledge: architecture` |

Key rules:
- Persona files are reusable across pieces. Never include piece-specific procedures (report names, movement references)
- Policy REJECT lists are what reviewers enforce. If a criterion is not in the policy REJECT list, reviewers will not catch it — even if knowledge explains the reasoning
- Knowledge provides the WHY behind policy criteria. Knowledge alone does not trigger enforcement
- Instructions are bound to a single piece movement. They reference procedures, not principles
- Piece YAML `instruction_template` is for movement-specific details (which reports to read, movement routing, output templates)

**Separation of concerns in piece engine:**
- `PieceEngine` - Orchestration, state management, event emission
- `StepExecutor` - Single movement execution (3-phase model)
- `ParallelRunner` - Parallel movement execution
- `RuleEvaluator` - Rule matching and evaluation
- `InstructionBuilder` - Instruction template processing

**Session management:** Agent sessions are stored per-cwd in `~/.claude/projects/{encoded-path}/` (Claude Code) or in-memory (Codex). Sessions are resumed across phases (Phase 1 → Phase 2 → Phase 3) to maintain context. When `cwd !== projectCwd` (worktree/clone execution), session resume is skipped to avoid cross-directory contamination.

## Isolated Execution (Shared Clone)

When tasks specify `worktree: true` or `worktree: "path"`, code runs in a `git clone --shared` (lightweight clone with independent `.git` directory). Clones are ephemeral: created before task execution, auto-committed + pushed after success, then deleted.

> **Why `worktree` in YAML but `git clone --shared` internally?** The YAML field name `worktree` is retained for backward compatibility. The original implementation used `git worktree`, but git worktrees have a `.git` file containing `gitdir: /path/to/main/.git/worktrees/...`. Claude Code follows this path and recognizes the main repository as the project root, causing agents to work on main instead of the worktree. `git clone --shared` creates an independent `.git` directory that prevents this traversal.

Key constraints:

- **Independent `.git`**: Shared clones have their own `.git` directory, preventing Claude Code from traversing `gitdir:` back to the main repository.
- **Ephemeral lifecycle**: Clone is created → task runs → auto-commit + push → clone is deleted. Branches are the single source of truth.
- **Session isolation**: Claude Code sessions are stored per-cwd in `~/.claude/projects/{encoded-path}/`. Sessions from the main project cannot be resumed in a clone. The engine skips session resume when `cwd !== projectCwd`.
- **No node_modules**: Clones only contain tracked files. `node_modules/` is absent.
- **Dual cwd**: `cwd` = clone path (where agents run), `projectCwd` = project root. Reports write to `cwd/.takt/runs/{slug}/reports/` (clone) to prevent agents from discovering the main repository. Logs and session data write to `projectCwd`.
- **List**: Use `takt list` to list branches. Instruct action creates a temporary clone for the branch, executes, pushes, then removes the clone.

## Error Propagation

`ClaudeResult` (from SDK) has an `error` field. This must be propagated through `AgentResponse.error` → session log history → console output. Without this, SDK failures (exit code 1, rate limits, auth errors) appear as empty `blocked` status with no diagnostic info.

**Error handling flow:**
1. Provider error (Claude SDK / Codex) → `AgentResponse.error`
2. `StepExecutor` captures error → `PieceEngine` emits `step:complete` with error
3. Error logged to session log (`.takt/logs/{sessionId}.jsonl`)
4. Console output shows error details
5. Piece transitions to `ABORT` step if error is unrecoverable

## Debugging

**Debug logging:** Set `debug_enabled: true` in `~/.takt/config.yaml` or create a `.takt/debug.yaml` file:
```yaml
enabled: true
```

Debug logs are written to `.takt/logs/debug.log` (ndjson format). Log levels: `debug`, `info`, `warn`, `error`.

**Verbose mode:** Create `.takt/verbose` file (empty file) to enable verbose console output. This automatically enables debug logging and sets log level to `debug`.

**Session logs:** All piece executions are logged to `.takt/logs/{sessionId}.jsonl`. Use `tail -f .takt/logs/{sessionId}.jsonl` to monitor in real-time.

**Testing with mocks:** Use `--provider mock` to test pieces without calling real AI APIs. Mock responses are deterministic and configurable via test fixtures.

## Testing Notes

- Vitest for testing framework
- Tests use file system fixtures in `__tests__/` subdirectories
- Mock pieces and agent configs for integration tests
- Test single files: `npx vitest run src/__tests__/filename.test.ts`
- Pattern matching: `npx vitest run -t "test pattern"`
- Integration tests: Tests with `it-` prefix are integration tests that simulate full piece execution
- Engine tests: Tests with `engine-` prefix test specific PieceEngine scenarios (happy path, error handling, parallel execution, etc.)

## Important Implementation Notes

**Persona prompt resolution:**
- Persona paths in piece YAML are resolved relative to the piece file's directory
- `../facets/personas/coder.md` resolves from piece file location
- Built-in personas are loaded from `builtins/{lang}/facets/personas/`
- User personas are loaded from `~/.takt/facets/personas/`
- If persona file doesn't exist, the persona string is used as inline system prompt

**Report directory structure:**
- Report dirs are created at `.takt/runs/{timestamp}-{slug}/reports/`
- Report files specified in `output_contracts` are written relative to report dir
- Report dir path is available as `{report_dir}` variable in instruction templates
- When `cwd !== projectCwd` (worktree execution), reports write to `cwd/.takt/runs/{slug}/reports/` (clone dir) to prevent agents from discovering the main repository path

**Session continuity across phases:**
- Agent sessions persist across Phase 1 → Phase 2 → Phase 3 for context continuity
- Session ID is passed via `resumeFrom` in `RunAgentOptions`
- Sessions are stored per-cwd, so worktree executions create new sessions
- Use `takt clear` to reset all agent sessions

**Worktree execution gotchas:**
- `git clone --shared` creates independent `.git` directory (not `git worktree`)
- Clone cwd ≠ project cwd: agents work in clone, reports write to clone, logs write to project
- Session resume is skipped when `cwd !== projectCwd` to avoid cross-directory contamination
- Reports write to `cwd/.takt/runs/{slug}/reports/` (clone) to prevent agents from discovering the main repository path via instruction
- Clones are ephemeral: created → task runs → auto-commit + push → deleted
- Use `takt list` to manage task branches after clone deletion

**Rule evaluation quirks:**
- Tag-based rules match by array index (0-based), not by exact condition text
- **v0.3.8+:** When multiple `[STEP:N]` tags appear in output, **last match wins** (not first)
- `ai()` conditions are evaluated by Claude/Codex, not by string matching
- Aggregate conditions (`all()`, `any()`) only work in parallel parent movements
- Fail-fast: if rules exist but no rule matches, piece aborts
- Interactive-only rules are skipped in pipeline mode (`rule.interactiveOnly === true`)

**Provider-specific behavior:**
- Claude: Uses session files in `~/.claude/projects/`
- Codex: In-memory sessions
- Model names are passed directly to provider (no alias resolution in TAKT)
- Claude supports aliases: `opus`, `sonnet`, `haiku`
- Codex defaults to `codex` if model not specified

**Permission modes (provider-independent values):**
- `readonly`: Read-only access, no file modifications (Claude: `default`, Codex: `read-only`)
- `edit`: Allow file edits with confirmation (Claude: `acceptEdits`, Codex: `workspace-write`)
- `full`: Bypass all permission checks (Claude: `bypassPermissions`, Codex: `danger-full-access`)
- Resolved via `provider_profiles` (global/project config) with `required_permission_mode` as minimum floor
- Movement-level `required_permission_mode` sets the minimum; `provider_profiles` defaults/overrides can raise it
