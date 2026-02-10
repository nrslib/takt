# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md)

**T**ask **A**gent **K**oordination **T**ool - Define how AI agents coordinate, where humans intervene, and what gets recorded — in YAML

TAKT runs multiple AI agents (Claude Code, Codex) through YAML-defined workflows. Each step — who runs, what they see, what's allowed, what happens on failure — is declared in a piece file, not left to the agent.

TAKT is built with TAKT itself (dogfooding).

## Metaphor

TAKT uses a music metaphor to describe orchestration:

- **Piece**: A task execution definition (what to do and how agents coordinate)
- **Movement**: A step inside a piece (a single stage in the flow)
- **Orchestration**: The engine that coordinates agents across movements

You can read every term as standard workflow language (piece = workflow, movement = step), but the metaphor is used to keep the system conceptually consistent.

## Why TAKT

- AI agents are powerful but non-deterministic — TAKT makes their decisions visible and replayable
- Multi-agent coordination needs structure — pieces define who does what, in what order, with what permissions
- CI/CD integration needs guardrails — pipeline mode runs agents non-interactively with full audit logs

## What TAKT Controls and Manages

TAKT **controls** agent execution and **manages** prompt components.

| | Concern | Description |
|---|---------|-------------|
| Control | **Routing** | State transition rules (who runs when) |
| Control | **Tools & Permissions** | Readonly, edit, full access (what's allowed) |
| Control | **Recording** | Session logs, reports (what gets captured) |
| Manage | **Personas** | Agent roles and expertise (who they act as) |
| Manage | **Policies** | Coding standards, quality criteria, prohibitions (what to uphold) |
| Manage | **Knowledge** | Domain knowledge, architecture info (what to reference) |

Personas, policies, and knowledge are managed as independent files and freely combined across workflows ([Faceted Prompting](./docs/faceted-prompting.md)). Change a policy in one file and every workflow using it gets the update.

## What TAKT is NOT

- **Not an autonomous engineer** — TAKT coordinates agents but doesn't decide what to build. You provide the task, TAKT governs the execution.
- **Not a Skill or Swarm replacement** — Skills extend a single agent's knowledge. Swarm parallelizes agents. TAKT defines the workflow structure across agents — which agent runs, in what order, with what rules.
- **Not fully automatic by default** — Every step can require human approval. Automation is opt-in (pipeline mode), not the default.

## Requirements

Choose one:

- **Use provider CLIs**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) installed
- **Use direct API**: **Anthropic API Key** or **OpenAI API Key** (no CLI required)

Additionally required:

- [GitHub CLI](https://cli.github.com/) (`gh`) — Only needed for `takt #N` (GitHub Issue execution)

**Pricing Note**: When using API Keys, TAKT directly calls the Claude API (Anthropic) or OpenAI API. The pricing structure is the same as using Claude Code or Codex. Be mindful of costs, especially when running automated tasks in CI/CD environments, as API usage can accumulate.

## Installation

```bash
npm install -g takt
```

## Quick Start

```bash
# Interactive mode - refine task requirements with AI, then execute
takt

# Execute GitHub Issue as task (both work the same)
takt #6
takt --issue 6

# Pipeline execution (non-interactive, for scripts/CI)
takt --pipeline --task "Fix the bug" --auto-pr
```

## Usage

### Interactive Mode

A mode where you refine task content through conversation with AI before execution. Useful when task requirements are ambiguous or when you want to clarify content while consulting with AI.

```bash
# Start interactive mode (no arguments)
takt

# Specify initial message (short word only)
takt hello
```

**Note:** `--task` option skips interactive mode and executes the task directly. Issue references (`#6`, `--issue`) are used as initial input in interactive mode.

**Flow:**
1. Select piece
2. Select interactive mode (assistant / persona / quiet / passthrough)
3. Refine task content through conversation with AI
4. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`), or use `/play <task>` to execute a task immediately
5. Execute (create worktree, run piece, create PR)

#### Interactive Mode Variants

| Mode | Description |
|------|-------------|
| `assistant` | Default. AI asks clarifying questions before generating task instructions. |
| `persona` | Conversation with the first movement's persona (uses its system prompt and tools). |
| `quiet` | Generates task instructions without asking questions (best-effort). |
| `passthrough` | Passes user input directly as task text without AI processing. |

Pieces can set a default mode via the `interactive_mode` field in YAML.

#### Execution Example

```
$ takt

Select piece:
  ❯ 🎼 default (current)
    📁 Development/
    📁 Research/
    Cancel

Interactive mode - Enter task content. Commands: /go (execute), /cancel (exit)

> I want to add user authentication feature

[AI confirms and organizes requirements]

> /go

Proposed task instructions:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Proceed with these task instructions? (Y/n) y

? Create worktree? (Y/n) y

[Piece execution starts...]
```

### Direct Task Execution

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

### GitHub Issue Tasks

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

### Task Management (add / run / watch / list)

Batch processing using `.takt/tasks.yaml` with task directories under `.takt/tasks/{slug}/`. Useful for accumulating multiple tasks and executing them together later.

#### Add Task (`takt add`)

```bash
# Refine task requirements through AI conversation, then add task
takt add

# Add task from GitHub Issue (issue number reflected in branch name)
takt add #28
```

#### Execute Tasks (`takt run`)

```bash
# Execute all pending tasks in .takt/tasks.yaml
takt run
```

#### Watch Tasks (`takt watch`)

```bash
# Monitor .takt/tasks.yaml and auto-execute tasks (resident process)
takt watch
```

#### List Task Branches (`takt list`)

```bash
# List task branches (merge/delete)
takt list

# Non-interactive mode (for CI/scripts)
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

#### Task Directory Workflow (Create / Run / Verify)

1. Run `takt add` and confirm a pending record is created in `.takt/tasks.yaml`.
2. Open the generated `.takt/tasks/{slug}/order.md` and add detailed specifications/references as needed.
3. Run `takt run` (or `takt watch`) to execute pending tasks from `tasks.yaml`.
4. Verify outputs in `.takt/runs/{slug}/reports/` using the same slug as `task_dir`.

### Pipeline Mode (for CI/Automation)

Specifying `--pipeline` enables non-interactive pipeline mode. Automatically creates branch → runs piece → commits & pushes. Suitable for CI/CD automation.

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

**GitHub Integration:** When using TAKT in GitHub Actions, see [takt-action](https://github.com/nrslib/takt-action). You can automate PR reviews and task execution. Refer to the [CI/CD Integration](#cicd-integration) section for details.

### Other Commands

```bash
# Interactively switch pieces
takt switch

# Copy builtin pieces/personas to project .takt/ for customization
takt eject

# Copy to ~/.takt/ (global) instead
takt eject --global

# Clear agent conversation sessions
takt clear

# Deploy builtin pieces/personas as Claude Code Skill
takt export-cc

# List available facets across layers
takt catalog
takt catalog personas

# Eject a specific facet for customization
takt eject persona coder
takt eject instruction plan --global

# Preview assembled prompts for each movement and phase
takt prompt [piece]

# Configure permission mode
takt config

# Reset piece categories to builtin defaults
takt reset categories
```

### Recommended Pieces

| Piece | Recommended Use |
|----------|-----------------|
| `default` | Serious development tasks. Used for TAKT's own development. Multi-stage review with parallel reviews (architect + security). |
| `minimal` | Simple fixes and straightforward tasks. Minimal piece with basic review. |
| `review-fix-minimal` | Review & fix piece. Specialized for iterative improvement based on review feedback. |
| `research` | Investigation and research. Autonomously executes research without asking questions. |

### Main Options

| Option | Description |
|--------|-------------|
| `--pipeline` | **Enable pipeline (non-interactive) mode** — Required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --piece <name or path>` | Piece name or path to piece YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, piece-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `--create-worktree <yes\|no>` | Skip worktree confirmation prompt |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|codex\|mock) |
| `--model <name>` | Override agent model |

## Pieces

TAKT uses YAML-based piece definitions and rule-based routing. Builtin pieces are embedded in the package, with user pieces in `~/.takt/pieces/` taking priority. Use `takt eject` to copy builtins to `~/.takt/` for customization.

> **Note (v0.4.0)**: Internal terminology has changed from "step" to "movement" for piece components. User-facing piece files remain compatible, but if you customize pieces, you may see `movements:` instead of `steps:` in YAML files. The functionality remains the same.

### Piece Example

```yaml
name: default
max_iterations: 10
initial_movement: plan

# Section maps — key: file path (relative to this YAML)
personas:
  planner: ../personas/planner.md
  coder: ../personas/coder.md
  reviewer: ../personas/architecture-reviewer.md

policies:
  coding: ../policies/coding.md

knowledge:
  architecture: ../knowledge/architecture.md

movements:
  - name: plan
    persona: planner
    model: opus
    edit: false
    rules:
      - condition: Planning complete
        next: implement
    instruction_template: |
      Analyze the request and create an implementation plan.

  - name: implement
    persona: coder
    policy: coding
    knowledge: architecture
    edit: true
    permission_mode: edit
    rules:
      - condition: Implementation complete
        next: review
      - condition: Blocked
        next: ABORT
    instruction_template: |
      Implement based on the plan.

  - name: review
    persona: reviewer
    knowledge: architecture
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction_template: |
      Review the implementation from architecture and code quality perspectives.
```

### Persona-less Movements

The `persona` field is optional. When omitted, the movement executes using only the `instruction_template` without a system prompt. This is useful for simple tasks that don't require persona customization.

```yaml
  - name: summarize
    # No persona specified — uses instruction_template only
    edit: false
    rules:
      - condition: Summary complete
        next: COMPLETE
    instruction_template: |
      Read the report and provide a concise summary.
```

You can also write an inline system prompt as the `persona` value (if the specified file doesn't exist):

```yaml
  - name: review
    persona: "You are a code reviewer. Focus on readability and maintainability."
    edit: false
    instruction_template: |
      Review code quality.
```

### Parallel Movements

Execute sub-movements in parallel within a movement and evaluate with aggregate conditions:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        persona: reviewer
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review architecture and code quality.
      - name: security-review
        persona: security-reviewer
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review for security vulnerabilities.
    rules:
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: true if ALL sub-movements matched condition X
- `any("X")`: true if ANY sub-movement matched condition X
- Sub-movement `rules` define possible outcomes, but `next` is optional (parent controls transition)

### Rule Condition Types

| Type | Syntax | Description |
|------|--------|-------------|
| Tag-based | `"condition text"` | Agent outputs `[MOVEMENTNAME:N]` tag, matched by index |
| AI judge | `ai("condition text")` | AI evaluates condition against agent output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-movement matched conditions |

## Builtin Pieces

TAKT includes multiple builtin pieces:

| Piece | Description |
|----------|-------------|
| `default` | Full development piece: plan → implement → AI review → parallel review (architect + QA) → supervisor approval. Includes fix loops at each review stage. |
| `minimal` | Quick piece: plan → implement → review → supervisor. Minimal steps for fast iteration. |
| `review-fix-minimal` | Review-focused piece: review → fix → supervisor. For iterative improvement based on review feedback. |
| `research` | Research piece: planner → digger → supervisor. Autonomously executes research without asking questions. |
| `expert` | Full-stack development piece: architecture, frontend, security, QA reviews with fix loops. |
| `expert-cqrs` | Full-stack development piece (CQRS+ES specialized): CQRS+ES, frontend, security, QA reviews with fix loops. |
| `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |
| `coding` | Lightweight development piece: planner → implement → parallel review (AI antipattern + architecture) → fix. Fast feedback loop without supervisor. |
| `passthrough` | Thinnest wrapper. Pass task directly to coder as-is. No review. |
| `compound-eye` | Multi-model review: sends the same instruction to Claude and Codex simultaneously, then synthesizes both responses. |
| `review-only` | Read-only code review piece that makes no changes. |
| `structural-reform` | Full project review and structural reform: iterative codebase restructuring with staged file splits. |
| `unit-test` | Unit test focused piece: test analysis → test implementation → review → fix. |
| `e2e-test` | E2E test focused piece: E2E analysis → E2E implementation → review → fix (Vitest-based E2E flow). |

**Per-persona provider overrides:** Use `persona_providers` in config to route specific personas to different providers (e.g., coder on Codex, reviewers on Claude) without duplicating pieces.

Use `takt switch` to switch pieces.

## Builtin Personas

| Persona | Description |
|---------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **architect-planner** | Task analysis and design planning: investigates code, resolves unknowns, creates implementation plans |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **frontend-reviewer** | Frontend (React/Next.js) code quality and best practices review |
| **cqrs-es-reviewer** | CQRS+Event Sourcing architecture and implementation review |
| **qa-reviewer** | Test coverage and quality assurance review |
| **security-reviewer** | Security vulnerability assessment |
| **conductor** | Phase 3 judgment specialist: reads reports/responses and outputs status tags |
| **supervisor** | Final validation, approval |
| **expert-supervisor** | Expert-level final validation with comprehensive review integration |
| **research-planner** | Research task planning and scope definition |
| **research-digger** | Deep investigation and information gathering |
| **research-supervisor** | Research quality validation and completeness assessment |
| **test-planner** | Test strategy analysis and comprehensive test planning |
| **pr-commenter** | Posts review findings as GitHub PR comments |

## Custom Personas

Create persona prompts in Markdown files:

```markdown
# ~/.takt/personas/my-reviewer.md

You are a code reviewer specialized in security.

## Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic
```

## Model Selection

The `model` field (in piece movements, agent config, or global config) is passed directly to the provider (Claude Code CLI / Codex SDK). TAKT does not resolve model aliases.

### Claude Code

Claude Code supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

### Codex

The model string is passed to the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

## Project Structure

```
~/.takt/                    # Global configuration directory
├── config.yaml             # Global config (provider, model, piece, etc.)
├── pieces/                 # User piece definitions (override builtins)
│   └── custom.yaml
└── personas/               # User persona prompt files (.md)
    └── my-persona.md

.takt/                      # Project-level configuration
├── config.yaml             # Project config (current piece, etc.)
├── tasks/                  # Task input directories (.takt/tasks/{slug}/order.md, etc.)
├── tasks.yaml              # Pending tasks metadata (task_dir, piece, worktree, etc.)
└── runs/                   # Run-scoped artifacts
    └── {slug}/
        ├── reports/        # Execution reports (auto-generated)
        ├── context/        # knowledge/policy/previous_response snapshots
        ├── logs/           # NDJSON session logs for this run
        └── meta.json       # Run metadata
```

Builtin resources are embedded in the npm package (`builtins/`). User files in `~/.takt/` take priority.

### Global Configuration

Configure default provider and model in `~/.takt/config.yaml`:

```yaml
# ~/.takt/config.yaml
language: en
default_piece: default
log_level: info
provider: claude         # Default provider: claude or codex
model: sonnet            # Default model (optional)
branch_name_strategy: romaji  # Branch name generation: 'romaji' (fast) or 'ai' (slow)
prevent_sleep: false     # Prevent macOS idle sleep during execution (caffeinate)
notification_sound: true # Enable/disable notification sounds
concurrency: 1           # Parallel task count for takt run (1-10, default: 1 = sequential)
task_poll_interval_ms: 500  # Polling interval for new tasks during takt run (100-5000, default: 500)
interactive_preview_movements: 3  # Movement previews in interactive mode (0-10, default: 3)

# Per-persona provider overrides (optional)
# Route specific personas to different providers without duplicating pieces
# persona_providers:
#   coder: codex             # Run coder on Codex
#   ai-antipattern-reviewer: claude  # Keep reviewers on Claude

# API Key configuration (optional)
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY
anthropic_api_key: sk-ant-...  # For Claude (Anthropic)
# openai_api_key: sk-...       # For Codex (OpenAI)

# Builtin piece filtering (optional)
# builtin_pieces_enabled: true           # Set false to disable all builtins
# disabled_builtins: [magi, passthrough] # Disable specific builtin pieces

# Pipeline execution configuration (optional)
# Customize branch names, commit messages, and PR body.
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}
```

**Note:** The Codex SDK requires running inside a Git repository. `--skip-git-repo-check` is only available in the Codex CLI.

**API Key Configuration Methods:**

1. **Set via environment variables**:
   ```bash
   export TAKT_ANTHROPIC_API_KEY=sk-ant-...  # For Claude
   # or
   export TAKT_OPENAI_API_KEY=sk-...         # For Codex
   ```

2. **Set in config file**:
   Write `anthropic_api_key` or `openai_api_key` in `~/.takt/config.yaml` as shown above

Priority: Environment variables > `config.yaml` settings

**Notes:**
- If you set an API Key, installing Claude Code or Codex is not necessary. TAKT directly calls the Anthropic API or OpenAI API.
- **Security**: If you write API Keys in `config.yaml`, be careful not to commit this file to Git. Consider using environment variables or adding `~/.takt/config.yaml` to `.gitignore`.

**Pipeline Template Variables:**

| Variable | Available In | Description |
|----------|-------------|-------------|
| `{title}` | Commit message | Issue title |
| `{issue}` | Commit message, PR body | Issue number |
| `{issue_body}` | PR body | Issue body |
| `{report}` | PR body | Piece execution report |

**Model Resolution Priority:**
1. Piece movement `model` (highest priority)
2. Custom agent `model`
3. Global config `model`
4. Provider default (Claude: sonnet, Codex: codex)

## Detailed Guides

### Task Directory Format

TAKT stores task metadata in `.takt/tasks.yaml`, and each task's long specification in `.takt/tasks/{slug}/`.

**Recommended layout**:

```text
.takt/
  tasks/
    20260201-015714-foptng/
      order.md
      schema.sql
      wireframe.png
  tasks.yaml
  runs/
    20260201-015714-foptng/
      reports/
```

**tasks.yaml record**:

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

`takt add` creates `.takt/tasks/{slug}/order.md` automatically and saves `task_dir` to `tasks.yaml`.

#### Isolated Execution with Shared Clone

Specifying `worktree` in YAML task files executes each task in an isolated clone created with `git clone --shared`, keeping your main working directory clean:

- `worktree: true` - Auto-create shared clone in adjacent directory (or location specified by `worktree_dir` config)
- `worktree: "/path/to/dir"` - Create at specified path
- `branch: "feat/xxx"` - Use specified branch (auto-generated as `takt/{timestamp}-{slug}` if omitted)
- Omit `worktree` - Execute in current directory (default)

> **Note**: The YAML field name remains `worktree` for backward compatibility. Internally, it uses `git clone --shared` instead of `git worktree`. Git worktrees have a `.git` file containing `gitdir:` pointing to the main repository, which Claude Code follows to recognize the main repository as the project root. Shared clones have an independent `.git` directory, preventing this issue.

Clones are ephemeral. After task completion, they auto-commit + push, then delete the clone. Branches are the only persistent artifacts. Use `takt list` to list, merge, or delete branches.

### Session Logs

TAKT writes session logs in NDJSON (`.jsonl`) format to `.takt/runs/{slug}/logs/`. Each record is atomically appended, so partial logs are preserved even if the process crashes, and you can track in real-time with `tail -f`.

- `.takt/runs/{slug}/logs/{sessionId}.jsonl` - NDJSON session log per piece execution
- `.takt/runs/{slug}/meta.json` - Run metadata (`task`, `piece`, `start/end`, `status`, etc.)

Record types: `piece_start`, `step_start`, `step_complete`, `piece_complete`, `piece_abort`

The latest previous response is stored at `.takt/runs/{slug}/context/previous_responses/latest.md` and inherited automatically.

### Adding Custom Pieces

Add YAML files to `~/.takt/pieces/` or customize builtins with `takt eject`:

```bash
# Copy default piece to ~/.takt/pieces/ and edit
takt eject default
```

```yaml
# ~/.takt/pieces/my-piece.yaml
name: my-piece
description: Custom piece
max_iterations: 5
initial_movement: analyze

personas:
  analyzer: ~/.takt/personas/analyzer.md
  coder: ../personas/coder.md

movements:
  - name: analyze
    persona: analyzer
    edit: false
    rules:
      - condition: Analysis complete
        next: implement
    instruction_template: |
      Thoroughly analyze this request.

  - name: implement
    persona: coder
    edit: true
    permission_mode: edit
    pass_previous_response: true
    rules:
      - condition: Complete
        next: COMPLETE
    instruction_template: |
      Implement based on the analysis.
```

> **Note**: `{task}`, `{previous_response}`, `{user_inputs}` are automatically injected into instructions. Explicit placeholders are only needed if you want to control their position in the template.

### Specifying Personas by Path

Map keys to file paths in section maps, then reference keys from movements:

```yaml
# Section maps (relative to piece file)
personas:
  coder: ../personas/coder.md
  reviewer: ~/.takt/personas/my-reviewer.md
```

### Piece Variables

Variables available in `instruction_template`:

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Piece-wide turn count (total steps executed) |
| `{max_iterations}` | Maximum iteration count |
| `{movement_iteration}` | Per-movement iteration count (times this movement has been executed) |
| `{previous_response}` | Output from previous movement (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during piece (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/runs/20250126-143052-task-summary/reports`) |
| `{report:filename}` | Expands to `{report_dir}/filename` (e.g., `{report:00-plan.md}`) |

### Piece Design

Elements needed for each piece movement:

**1. Persona** - Referenced by section map key (used as system prompt):

```yaml
persona: coder                       # Key from personas section map
persona_name: coder                  # Display name (optional)
```

**2. Rules** - Define routing from movement to next movement. The instruction builder auto-injects status output rules, so agents know which tags to output:

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Blocked"
    next: ABORT
```

Special `next` values: `COMPLETE` (success), `ABORT` (failure)

**3. Movement Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `edit` | - | Whether movement can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous movement output to `{previous_response}` |
| `allowed_tools` | - | List of tools agent can use (Read, Glob, Grep, Edit, Write, Bash, etc.) |
| `provider` | - | Override provider for this movement (`claude` or `codex`) |
| `model` | - | Override model for this movement |
| `permission_mode` | - | Permission mode: `readonly`, `edit`, `full` (provider-independent) |
| `output_contracts` | - | Output contract definitions for report files |
| `quality_gates` | - | AI directives for movement completion requirements |
| `mcp_servers` | - | MCP (Model Context Protocol) server configuration (stdio/SSE/HTTP) |

## API Usage Example

```typescript
import { PieceEngine, loadPiece } from 'takt';  // npm install takt

const config = loadPiece('default');
if (!config) {
  throw new Error('Piece not found');
}
const engine = new PieceEngine(config, process.cwd(), 'My task');

engine.on('step:complete', (step, response) => {
  console.log(`${step.name}: ${response.status}`);
});

await engine.run();
```

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

## CI/CD Integration

### GitHub Actions

TAKT provides a GitHub Action for automating PR reviews and task execution. See [takt-action](https://github.com/nrslib/takt-action) for details.

**Piece example** (see [.github/workflows/takt-action.yml](../.github/workflows/takt-action.yml) in this repository):

```yaml
name: TAKT

on:
  issue_comment:
    types: [created]

jobs:
  takt:
    if: contains(github.event.comment.body, '@takt')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run TAKT
        uses: nrslib/takt-action@main
        with:
          anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

**Cost Warning**: TAKT uses AI APIs (Claude or OpenAI), which can incur significant costs, especially when tasks are auto-executed in CI/CD environments. Monitor API usage and set up billing alerts.

### Other CI Systems

For CI systems other than GitHub, use pipeline mode:

```bash
# Install takt
npm install -g takt

# Run in pipeline mode
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

For authentication, set `TAKT_ANTHROPIC_API_KEY` or `TAKT_OPENAI_API_KEY` environment variables (TAKT-specific prefix).

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...
```

## Documentation

- [Faceted Prompting](./docs/faceted-prompting.md) - Separation of Concerns for AI prompts (Persona, Policy, Instruction, Knowledge, Output Contract)
- [Piece Guide](./docs/pieces.md) - Creating and customizing pieces
- [Agent Guide](./docs/agents.md) - Configuring custom agents
- [Changelog](../CHANGELOG.md) - Version history
- [Security Policy](../SECURITY.md) - Vulnerability reporting
- [Blog: TAKT - AI Agent Orchestration](https://zenn.dev/nrs/articles/c6842288a526d7) - Design philosophy and practical usage guide (Japanese)

## License

MIT - See [LICENSE](../LICENSE) for details.
