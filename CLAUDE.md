# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAKT (TAKT Agent Koordination Topology) is a multi-agent orchestration system for Claude Code. It enables YAML-based piece definitions that coordinate multiple AI agents through state machine transitions with rule-based routing.

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
| `npm run prepublishOnly` | Lint, build, and test before publishing |

## CLI Subcommands

| Command | Description |
|---------|-------------|
| `takt {task}` | Execute task with current piece |
| `takt` | Interactive task input mode (chat with AI to refine requirements) |
| `takt run` | Execute all pending tasks from `.takt/tasks/` once |
| `takt watch` | Watch `.takt/tasks/` and auto-execute tasks (resident process) |
| `takt add [task]` | Add a new task via AI conversation |
| `takt list` | List task branches (merge, delete, retry) |
| `takt clear` | Clear agent conversation sessions (reset state) |
| `takt eject [type] [name]` | Copy builtin piece or facet for customization (`--global` for ~/.takt/) |
| `takt prompt [piece]` | Preview assembled prompts for each movement and phase |
| `takt catalog [type]` | List available facets (personas, policies, knowledge, etc.) |
| `takt export-cc` | Export takt pieces/agents as Claude Code Skill (~/.claude/) |
| `takt reset config` | Reset global config to builtin template |
| `takt reset categories` | Reset piece categories to builtin defaults |
| `takt metrics review` | Show review quality metrics |
| `takt purge` | Purge old analytics event files |
| `takt repertoire add <spec>` | Install a repertoire package from GitHub |
| `takt repertoire remove <scope>` | Remove an installed repertoire package |
| `takt repertoire list` | List installed repertoire packages |
| `takt config` | Configure settings (permission mode) |
| `takt --help` | Show help message |

**Interactive mode:** Running `takt` (without arguments) or `takt {initial message}` starts an interactive planning session. Supports 4 modes: `assistant` (default, AI asks clarifying questions), `passthrough` (passes input directly as task), `quiet` (generates instructions without questions), `persona` (uses first movement's persona for conversation). Type `/go` to execute the task with the selected piece, or `/cancel` to abort. Implemented in `src/features/interactive/`.

**Pipeline mode:** Specifying `--pipeline` enables non-interactive mode suitable for CI/CD. Automatically creates a branch, runs the piece, commits, and pushes. Use `--auto-pr` to also create a pull request. Use `--skip-git` to run piece only (no git operations). Implemented in `src/features/pipeline/`.

**GitHub issue references:** `takt #6` fetches issue #6 and executes it as a task.

### CLI Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode — required for CI/automation |
| `-t, --task <text>` | Task content (as alternative to GitHub issue) |
| `-i, --issue <N>` | GitHub issue number (equivalent to `#N` in interactive mode) |
| `--pr <number>` | PR number to fetch review comments and fix |
| `-w, --piece <name or path>` | Piece name or path to piece YAML file |
| `-b, --branch <name>` | Branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR after execution (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, piece-only) |
| `--repo <owner/repo>` | Repository for PR creation |
| `--create-worktree <yes\|no>` | Skip worktree confirmation prompt |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|codex\|opencode\|mock) |
| `--model <name>` | Override agent model |
| `--config <path>` | Path to global config file (default: `~/.takt/config.yaml`) |

## Architecture

### Core Flow

```
CLI (cli.ts → routing.ts)
  → Interactive mode / Pipeline mode / Direct task execution
    → PieceEngine (piece/engine/PieceEngine.ts)
      → Per movement, delegates to one of 4 runners:
        MovementExecutor  — Normal movements (3-phase execution)
        ParallelRunner    — Parallel sub-movements via Promise.allSettled()
        ArpeggioRunner    — Data-driven batch processing (CSV → template → LLM)
        TeamLeaderRunner  — Dynamic task decomposition into sub-parts
      → detectMatchedRule() → rule evaluation → determineNextMovementByRules()
```

### Three-Phase Movement Execution

Each normal movement executes in up to 3 phases (session is resumed across phases):

| Phase | Purpose | Tools | When |
|-------|---------|-------|------|
| Phase 1 | Main work (coding, review, etc.) | Movement's allowed_tools (Write excluded if report defined) | Always |
| Phase 2 | Report output | Write only | When `output_contracts` is defined |
| Phase 3 | Status judgment | None (judgment only) | When movement has tag-based rules |

Phase 2/3 are implemented in `src/core/piece/phase-runner.ts`. The session is resumed so the agent retains context from Phase 1.

### Rule Evaluation (5-Stage Fallback)

After movement execution, rules are evaluated to determine the next movement. Evaluation order (first match wins):

1. **Aggregate** (`all()`/`any()`) - For parallel parent movements
2. **Phase 3 tag** - `[STEP:N]` tag from status judgment output
3. **Phase 1 tag** - `[STEP:N]` tag from main execution output (fallback)
4. **AI judge (ai() only)** - AI evaluates `ai("condition text")` rules
5. **AI judge fallback** - AI evaluates ALL conditions as final resort

Implemented in `src/core/piece/evaluation/RuleEvaluator.ts`. The matched method is tracked as `RuleMatchMethod` type (`aggregate`, `auto_select`, `structured_output`, `phase3_tag`, `phase1_tag`, `ai_judge`, `ai_judge_fallback`).

### Key Components

**PieceEngine** (`src/core/piece/engine/PieceEngine.ts`)
- State machine that orchestrates agent execution via EventEmitter
- Manages movement transitions based on rule evaluation results
- Emits events: `movement:start`, `movement:complete`, `movement:blocked`, `movement:report`, `movement:user_input`, `movement:loop_detected`, `movement:cycle_detected`, `phase:start`, `phase:complete`, `piece:complete`, `piece:abort`, `iteration:limit`
- Supports loop detection (`LoopDetector`), cycle detection (`CycleDetector`), and iteration limits
- Maintains agent sessions per movement for conversation continuity
- Delegates to `MovementExecutor` (normal), `ParallelRunner` (parallel), `ArpeggioRunner` (data-driven batch), and `TeamLeaderRunner` (task decomposition)

**MovementExecutor** (`src/core/piece/engine/MovementExecutor.ts`)
- Executes a single piece movement through the 3-phase model
- Phase 1: Main agent execution (with tools)
- Phase 2: Report output (Write-only, optional)
- Phase 3: Status judgment (no tools, optional)
- Builds instructions via `InstructionBuilder`, detects matched rules via `RuleEvaluator`
- Writes facet snapshots (knowledge/policy) per movement iteration

**ArpeggioRunner** (`src/core/piece/engine/ArpeggioRunner.ts`)
- Data-driven batch processing: reads data from a source (e.g., CSV), expands templates per batch, calls LLM for each batch with concurrency control
- Supports retry logic with configurable `maxRetries` and `retryDelayMs`
- Merge strategies: `concat` (default, join with separator) or `custom` (inline JS or file-based)
- Optional output file writing via `outputPath`

**TeamLeaderRunner** (`src/core/piece/engine/TeamLeaderRunner.ts`)
- Decomposes a task into sub-parts via AI (`decomposeTask()`), then executes each part as a sub-agent
- Uses `PartDefinition` schema (id, title, instruction, optional timeoutMs) for decomposed tasks
- Configured via `TeamLeaderConfig` (maxParts ≤3, separate persona/tools/permissions for parts)
- Aggregates sub-part results and evaluates parent rules

**ParallelRunner** (`src/core/piece/engine/ParallelRunner.ts`)
- Executes parallel sub-movements concurrently via `Promise.allSettled()`
- Uses `ParallelLogger` to prefix sub-movement output for readable interleaved display
- Aggregates sub-movement results for parent rule evaluation with `all()` / `any()` conditions

**RuleEvaluator** (`src/core/piece/evaluation/RuleEvaluator.ts`)
- 5-stage fallback evaluation: aggregate → Phase 3 tag → Phase 1 tag → ai() judge → all-conditions AI judge
- Returns `RuleMatch` with index and detection method
- Fail-fast: throws if rules exist but no rule matched
- Tag detection uses **last match** when multiple `[STEP:N]` tags appear in output

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
- Agent is optional — movements can execute with `instruction_template` only (no system prompt)
- 5-layer resolution for provider/model: CLI `--provider` / `--model` → persona_providers → movement override → project `.takt/config.yaml` → global `~/.takt/config.yaml`
- Custom personas via `~/.takt/personas/<name>.md` or prompt files (.md)
- Inline system prompts: If agent file doesn't exist, the agent string is used as inline system prompt

**Provider Integration** (`src/infra/providers/`)
- Unified `Provider` interface: `setup(AgentSetup) → ProviderAgent`, `ProviderAgent.call(prompt, options) → AgentResponse`
- **Claude** (`src/infra/claude/`) - Uses `@anthropic-ai/claude-agent-sdk`
  - `client.ts` - High-level API: `callClaude()`, `callClaudeCustom()`, `callClaudeAgent()`, `callClaudeSkill()`
  - `process.ts` - SDK wrapper with `ClaudeProcess` class
  - `executor.ts` - Query execution
  - `query-manager.ts` - Concurrent query tracking with query IDs
- **Codex** (`src/infra/codex/`) - Uses `@openai/codex-sdk`
  - Retry logic with exponential backoff (3 attempts, 250ms base)
  - Stream handling with idle timeout (10 minutes)
- **OpenCode** (`src/infra/opencode/`) - Uses `@opencode-ai/sdk/v2`
  - Shared server pooling with `acquireClient()` / `releaseClient()`
  - Client-side permission auto-reply
  - Requires explicit `model` specification (no default)
- **Mock** (`src/infra/mock/`) - Deterministic responses for testing

**Configuration** (`src/infra/config/`)
- `loaders/pieceParser.ts` - YAML parsing, movement/rule normalization with Zod validation. Rule regex: `AI_CONDITION_REGEX = /^ai\("(.+)"\)$/`, `AGGREGATE_CONDITION_REGEX = /^(all|any)\((.+)\)$/`
- `loaders/pieceResolver.ts` - **3-layer resolution**: project `.takt/pieces/` → user `~/.takt/pieces/` → builtin `builtins/{lang}/pieces/`. Also supports repertoire packages `@{owner}/{repo}/{piece-name}`
- `loaders/pieceCategories.ts` - Piece categorization and filtering
- `loaders/agentLoader.ts` - Agent prompt file loading
- `paths.ts` - Directory structure (`.takt/`, `~/.takt/`), session management
- `global/globalConfig.ts` - Global configuration (provider, model, language, quiet mode)
- `project/projectConfig.ts` - Project-level configuration

**Task Management** (`src/features/tasks/`)
- `execute/taskExecution.ts` - Main task execution orchestration, worker pool for parallel tasks
- `execute/pieceExecution.ts` - Piece execution wrapper, analytics integration, NDJSON logging
- `add/index.ts` - Interactive task addition via AI conversation
- `list/index.ts` - List task branches with merge/delete/retry actions
- `watch/index.ts` - Watch for task files and auto-execute

**Repertoire** (`src/features/repertoire/`)
- Package management for external facet/piece collections
- Install from GitHub: `github:{owner}/{repo}@{ref}`
- Config validation via `takt-repertoire.yaml` (path constraints, min_version semver check)
- Lock file for resolved dependencies
- Packages installed to `~/.takt/repertoire/@{owner}/{repo}/`

**Analytics** (`src/features/analytics/`)
- Event types: `MovementResultEvent`, `ReviewFindingEvent`, `FixActionEvent`, `RebuttalEvent`
- NDJSON storage at `.takt/events/`
- Integrated into piece execution: movement results, review findings, fix actions

**Catalog** (`src/features/catalog/`)
- Scans 3 layers (builtin → user → project) for available facets
- Shows override detection and source provenance

**Faceted Prompting** (`src/faceted-prompting/`)
- Independent module (no TAKT dependencies) for composing prompts from facets
- `compose(facets, options)` → `ComposedPrompt` (systemPrompt + userMessage)
- Supports template rendering, context truncation, facet path resolution, scope references

**GitHub Integration** (`src/infra/github/`)
- `issue.ts` - Fetches issues via `gh` CLI, formats as task text, supports `createIssue()`
- `pr.ts` - Creates pull requests via `gh` CLI, supports draft PRs and custom templates

### Data Flow

1. User provides task (text or `#N` issue reference) or slash command → CLI
2. CLI loads piece with **priority**: project `.takt/pieces/` → user `~/.takt/pieces/` → builtin `builtins/{lang}/pieces/`
3. PieceEngine starts at `initial_movement`
4. Each movement: delegate to appropriate runner → 3-phase execution → `detectMatchedRule()` → `determineNextMovementByRules()`
5. Rule evaluation determines next movement name (uses **last match** when multiple `[STEP:N]` tags appear)
6. Special transitions: `COMPLETE` ends piece successfully, `ABORT` ends with failure

## Directory Structure

```
~/.takt/                  # Global user config (created on first run)
  config.yaml             # Language, provider, model, log level, etc.
  pieces/                 # User piece YAML files (override builtins)
  facets/                 # User facets
    personas/             # User persona prompt files (.md)
    policies/             # User policy files
    knowledge/            # User knowledge files
    instructions/         # User instruction files
    output-contracts/     # User output contract files
  repertoire/             # Installed repertoire packages
    @{owner}/{repo}/      # Per-package directory

.takt/                    # Project-level config
  config.yaml             # Project configuration
  facets/                 # Project-level facets
  tasks/                  # Task files for takt run
  runs/                   # Execution reports (runs/{slug}/reports/)
  logs/                   # Session logs in NDJSON format (gitignored)
  events/                 # Analytics event files (NDJSON)

builtins/                 # Bundled defaults (builtin, read from dist/ at runtime)
  en/                     # English
    facets/               # Facets (personas, policies, knowledge, instructions, output-contracts)
    pieces/               # Piece YAML files
  ja/                     # Japanese (same structure)
  project/                # Project-level template files
  skill/                  # Claude Code skill files
```

Builtin resources are embedded in the npm package (`builtins/`). Project files in `.takt/` take highest priority, then user files in `~/.takt/`, then builtins. Use `takt eject` to copy builtins for customization.

## Piece YAML Schema

```yaml
name: piece-name
description: Optional description
max_movements: 10
initial_movement: plan    # First movement to execute
interactive_mode: assistant  # Default interactive mode (assistant|passthrough|quiet|persona)
answer_agent: agent-name  # Route AskUserQuestion to this agent (optional)

# Piece-level provider options (inherited by all movements unless overridden)
piece_config:
  provider_options:
    codex: { network_access: true }
    opencode: { network_access: true }
    claude: { sandbox: { allow_unsandboxed_commands: true } }
  runtime:
    prepare: [node, gradle, ./custom-script.sh]  # Runtime environment preparation

# Loop monitors (cycle detection between movements)
loop_monitors:
  - cycle: [review, fix]        # Movement names forming the cycle
    threshold: 3                # Cycles before triggering judge
    judge:
      persona: supervisor
      instruction_template: "Evaluate if the fix loop is making progress..."
      rules:
        - condition: "Progress is being made"
          next: fix
        - condition: "No progress"
          next: ABORT

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
    session: continue                   # Session continuity: continue (default) | refresh
    policy: coding                      # Policy key (single or array)
    knowledge: architecture             # Knowledge key (single or array)
    instruction: plan                   # Instruction key (references section map)
    provider: claude                    # claude|codex|opencode|mock (optional)
    model: opus                         # Model name (optional)
    edit: true                          # Whether movement can edit files
    required_permission_mode: edit      # Required minimum permission mode (optional)
    quality_gates:                      # AI directives for completion (optional)
      - "All tests pass"
      - "No lint errors"
    provider_options:                   # Per-provider options (optional)
      codex: { network_access: true }
      claude: { sandbox: { excluded_commands: [rm] } }
    mcp_servers:                        # MCP server configuration (optional)
      my-server:
        command: npx
        args: [-y, my-mcp-server]
    instruction_template: |
      Custom instructions for this movement.
      {task}, {previous_response} are auto-injected if not present as placeholders.
    pass_previous_response: true        # Default: true
    output_contracts:
      report:
        - name: 01-plan.md             # Report file name
          format: plan                  # References report_formats map
          order: "Write the plan to {report_dir}/01-plan.md"  # Instruction prepend
    rules:
      - condition: "Human-readable condition"
        next: next-movement-name
      - condition: ai("AI evaluates this condition text")
        next: other-movement
      - condition: blocked
        next: ABORT
        requires_user_input: true       # Wait for user input (interactive only)

  # Parallel movement (sub-movements execute concurrently)
  - name: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        policy: review
        knowledge: architecture
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

  # Arpeggio movement (data-driven batch processing)
  - name: batch-process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data/items.csv     # Relative to piece YAML
      batch_size: 5                     # Rows per batch (default: 1)
      concurrency: 3                    # Concurrent LLM calls (default: 1)
      template: ./templates/process.txt # Prompt template file
      max_retries: 2                    # Retry attempts per batch (default: 2)
      retry_delay_ms: 1000             # Delay between retries (default: 1000)
      merge:
        strategy: concat                # concat (default) | custom
        separator: "\n---\n"           # For concat strategy
      output_path: ./output/result.txt  # Write merged results (optional)
    rules:
      - condition: "Processing complete"
        next: COMPLETE

  # Team leader movement (dynamic task decomposition)
  - name: implement
    team_leader:
      max_parts: 3                      # Max parallel parts (1-3, default: 3)
      timeout_ms: 600000               # Per-part timeout (default: 600s)
      part_persona: coder              # Persona for part agents
      part_edit: true                  # Edit permission for parts
      part_permission_mode: edit       # Permission mode for parts
      part_allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
    instruction_template: |
      Decompose this task into independent subtasks.
    rules:
      - condition: "All parts completed"
        next: review
```

Key points about movement types (mutually exclusive: `parallel`, `arpeggio`, `team_leader`):
- **Parallel**: Sub-movement `rules` define possible outcomes but `next` is ignored (parent handles routing). Parent uses `all("X")`/`any("X")` to aggregate.
- **Arpeggio**: Template placeholders: `{line:N}`, `{col:N:name}`, `{batch_index}`, `{total_batches}`. Merge custom strategy supports inline JS or file.
- **Team leader**: AI generates `PartDefinition[]` (JSON in ```json block), each part executed as sub-movement.

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

### Model Resolution

Model is resolved in the following priority order:

1. **Persona-level `model`** - `persona_providers.<persona>.model`
2. **Movement `model`** - `step.model` / `stepModel` (`piece movement` field)
3. **CLI/task override `model`** - `--model` or task options
4. **Local/Global config `model`** - `.takt/config.yaml` and `~/.takt/config.yaml` when the resolved provider matches
5. **Provider default** - Falls back to provider's default (for example, Claude: sonnet, Codex: gpt-5.2-codex)

### Loop Detection

Two distinct mechanisms:

**LoopDetector** (`src/core/piece/engine/loop-detector.ts`):
- Detects consecutive same-movement executions (simple counter)
- Configurable: `maxConsecutiveSameStep` (default: 10), `action` (`warn` | `abort` | `ignore`)

**CycleDetector** (`src/core/piece/engine/cycle-detector.ts`):
- Detects cyclic patterns between movements (e.g., review → fix → review → fix)
- Configured via `loop_monitors` in piece config (cycle pattern + threshold + judge)
- When threshold reached, triggers a synthetic judge movement for decision-making
- Resets after judge intervention to prevent immediate re-triggering

## NDJSON Session Logging

Session logs use NDJSON (`.jsonl`) format for real-time append-only writes. Record types:

| Record | Description |
|--------|-------------|
| `piece_start` | Piece initialization with task, piece name |
| `movement_start` | Movement execution start |
| `movement_complete` | Movement result with status, content, matched rule info |
| `piece_complete` | Successful completion |
| `piece_abort` | Abort with reason |

Files: `.takt/logs/{sessionId}.jsonl`, with `latest.json` pointer. Legacy `.json` format is still readable via `loadSessionLog()`.

## TypeScript Notes

- ESM modules with `.js` extensions in imports
- Strict TypeScript with `noUncheckedIndexedAccess`
- Zod v4 schemas for runtime validation (`src/core/models/schemas.ts`)
- Uses `@anthropic-ai/claude-agent-sdk` for Claude, `@openai/codex-sdk` for Codex, `@opencode-ai/sdk` for OpenCode

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
- `MovementExecutor` - Single movement execution (3-phase model)
- `ParallelRunner` - Parallel movement execution
- `ArpeggioRunner` - Data-driven batch processing
- `TeamLeaderRunner` - Dynamic task decomposition
- `RuleEvaluator` - Rule matching and evaluation
- `InstructionBuilder` - Instruction template processing

**Session management:** Agent sessions are stored per-cwd in `~/.claude/projects/{encoded-path}/` (Claude) or in-memory (Codex/OpenCode). Sessions are resumed across phases (Phase 1 → Phase 2 → Phase 3) to maintain context. Session key format: `{persona}:{provider}` to prevent cross-provider contamination. When `cwd !== projectCwd` (worktree/clone execution), session resume is skipped.

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

Provider errors must be propagated through `AgentResponse.error` → session log history → console output. Without this, SDK failures (exit code 1, rate limits, auth errors) appear as empty `blocked` status with no diagnostic info.

**Error handling flow:**
1. Provider error (Claude SDK / Codex / OpenCode) → `AgentResponse.error`
2. `MovementExecutor` captures error → `PieceEngine` emits `phase:complete` with error
3. Error logged to session log (`.takt/logs/{sessionId}.jsonl`)
4. Console output shows error details
5. Piece transitions to `ABORT` movement if error is unrecoverable

## Runtime Environment

Piece-level runtime preparation via `runtime.prepare` in piece config or `~/.takt/config.yaml`:

- **Presets**: `gradle` (sets `GRADLE_USER_HOME`, `JAVA_TOOL_OPTIONS`), `node` (sets `npm_config_cache`)
- **Custom scripts**: Arbitrary shell scripts, resolved relative to cwd or as absolute paths
- Environment injected: `TMPDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `CI=true`
- Creates `.takt/.runtime/` directory structure with `env.sh` for sourcing

Implemented in `src/core/runtime/runtime-environment.ts`.

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

- Vitest for testing framework (single-thread mode, 15s timeout, 5s teardown timeout)
- Unit tests: `src/__tests__/*.test.ts`
- E2E mock tests: configured via `vitest.config.e2e.mock.ts` (240s timeout, forceExit)
- E2E provider tests: configured via `vitest.config.e2e.provider.ts`
- Test single files: `npx vitest run src/__tests__/filename.test.ts`
- Pattern matching: `npx vitest run -t "test pattern"`
- Integration tests: Tests with `it-` prefix simulate full piece execution
- Engine tests: Tests with `engine-` prefix test PieceEngine scenarios (happy path, error handling, parallel, arpeggio, team-leader, etc.)
- Environment variables cleared in test setup: `TAKT_CONFIG_DIR`, `TAKT_NOTIFY_WEBHOOK`

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
- Session key: `{persona}:{provider}` prevents cross-provider session contamination
- Sessions are stored per-cwd, so worktree executions create new sessions
- Use `takt clear` to reset all agent sessions

**Rule evaluation quirks:**
- Tag-based rules match by array index (0-based), not by exact condition text
- When multiple `[STEP:N]` tags appear in output, **last match wins** (not first)
- `ai()` conditions are evaluated by the provider, not by string matching
- Aggregate conditions (`all()`, `any()`) only work in parallel parent movements
- Fail-fast: if rules exist but no rule matches, piece aborts
- Interactive-only rules are skipped in pipeline mode (`rule.interactiveOnly === true`)

**Provider-specific behavior:**
- Claude: Uses session files in `~/.claude/projects/`, supports aliases: `opus`, `sonnet`, `haiku`
- Codex: In-memory sessions, retry with exponential backoff (3 attempts)
- OpenCode: Shared server pooling, requires explicit `model`, client-side permission auto-reply
- Mock: Deterministic responses, scenario queue support
- Model names are passed directly to provider (no alias resolution in TAKT)

**Permission modes (provider-independent values):**
- `readonly`: Read-only access, no file modifications (Claude: `default`, Codex: `read-only`)
- `edit`: Allow file edits with confirmation (Claude: `acceptEdits`, Codex: `workspace-write`)
- `full`: Bypass all permission checks (Claude: `bypassPermissions`, Codex: `danger-full-access`)
- Resolved via `provider_profiles` (global/project config) with `required_permission_mode` as minimum floor
- Movement-level `required_permission_mode` sets the minimum; `provider_profiles` defaults/overrides can raise it
