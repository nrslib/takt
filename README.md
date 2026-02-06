# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md)

**T**ask **A**gent **K**oordination **T**ool - Define how AI agents coordinate, where humans intervene, and what gets recorded — in YAML

TAKT runs multiple AI agents (Claude Code, Codex) through YAML-defined workflows. Each step — who runs, what's allowed, what happens on failure — is declared in a piece file, not left to the agent.

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

**Note:** Issue references (`#6`) and `--task` / `--issue` options skip interactive mode and execute the task directly. All other inputs (including text with spaces) enter interactive mode for requirement refinement.

**Flow:**
1. Select piece
2. Refine task content through conversation with AI
3. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`), or use `/play <task>` to execute a task immediately
4. Execute (create worktree, run piece, create PR)

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

Batch processing using task files (`.takt/tasks/`). Useful for accumulating multiple tasks and executing them together later.

#### Add Task (`takt add`)

```bash
# Refine task requirements through AI conversation, then add task
takt add

# Add task from GitHub Issue (issue number reflected in branch name)
takt add #28
```

#### Execute Tasks (`takt run`)

```bash
# Execute all pending tasks in .takt/tasks/
takt run
```

#### Watch Tasks (`takt watch`)

```bash
# Monitor .takt/tasks/ and auto-execute tasks (resident process)
takt watch
```

#### List Task Branches (`takt list`)

```bash
# List task branches (merge/delete)
takt list
```

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

# Copy builtin pieces/agents to ~/.takt/ for customization
takt eject

# Clear agent conversation sessions
takt clear

# Deploy builtin pieces/agents as Claude Code Skill
takt export-cc

# Configure permission mode
takt config
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

movements:
  - name: plan
    agent: ../agents/default/planner.md
    model: opus
    edit: false
    rules:
      - condition: Planning complete
        next: implement
    instruction_template: |
      Analyze the request and create an implementation plan.

  - name: implement
    agent: ../agents/default/coder.md
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
    agent: ../agents/default/architecture-reviewer.md
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction_template: |
      Review the implementation from architecture and code quality perspectives.
```

### Agentless Movements

The `agent` field is optional. When omitted, the movement executes using only the `instruction_template` without a system prompt. This is useful for simple tasks that don't require agent behavior customization.

```yaml
  - name: summarize
    # No agent specified — uses instruction_template only
    edit: false
    rules:
      - condition: Summary complete
        next: COMPLETE
    instruction_template: |
      Read the report and provide a concise summary.
```

You can also write an inline system prompt as the `agent` value (if the specified file doesn't exist):

```yaml
  - name: review
    agent: "You are a code reviewer. Focus on readability and maintainability."
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
        agent: ../agents/default/architecture-reviewer.md
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review architecture and code quality.
      - name: security-review
        agent: ../agents/default/security-reviewer.md
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
| `default` | Full development piece: plan → architecture design → implement → AI review → parallel review (architect + security) → supervisor approval. Includes fix loops at each review stage. |
| `minimal` | Quick piece: plan → implement → review → supervisor. Minimal steps for fast iteration. |
| `review-fix-minimal` | Review-focused piece: review → fix → supervisor. For iterative improvement based on review feedback. |
| `research` | Research piece: planner → digger → supervisor. Autonomously executes research without asking questions. |
| `expert` | Full-stack development piece: architecture, frontend, security, QA reviews with fix loops. |
| `expert-cqrs` | Full-stack development piece (CQRS+ES specialized): CQRS+ES, frontend, security, QA reviews with fix loops. |
| `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |
| `passthrough` | Thinnest wrapper. Pass task directly to coder as-is. No review. |
| `review-only` | Read-only code review piece that makes no changes. |

**Hybrid Codex variants** (`*-hybrid-codex`): Each major piece has a Codex variant where the coder agent runs on Codex while reviewers use Claude. Available for: default, minimal, expert, expert-cqrs, passthrough, review-fix-minimal, coding.

Use `takt switch` to switch pieces.

## Builtin Agents

| Agent | Description |
|-------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **security-reviewer** | Security vulnerability assessment |
| **supervisor** | Final validation, approval |

## Custom Agents

Create agent prompts in Markdown files:

```markdown
# ~/.takt/agents/my-agents/reviewer.md

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
├── pieces/              # User piece definitions (override builtins)
│   └── custom.yaml
└── agents/                 # User agent prompt files (.md)
    └── my-agent.md

.takt/                      # Project-level configuration
├── config.yaml             # Project config (current piece, etc.)
├── tasks/                  # Pending task files (.yaml, .md)
├── completed/              # Completed tasks and reports
├── reports/                # Execution reports (auto-generated)
│   └── {timestamp}-{slug}/
└── logs/                   # NDJSON format session logs
    ├── latest.json         # Pointer to current/latest session
    ├── previous.json       # Pointer to previous session
    └── {sessionId}.jsonl   # NDJSON session log per piece execution
```

Builtin resources are embedded in the npm package (`dist/resources/`). User files in `~/.takt/` take priority.

### Global Configuration

Configure default provider and model in `~/.takt/config.yaml`:

```yaml
# ~/.takt/config.yaml
language: en
default_piece: default
log_level: info
provider: claude         # Default provider: claude or codex
model: sonnet            # Default model (optional)

# API Key configuration (optional)
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY
anthropic_api_key: sk-ant-...  # For Claude (Anthropic)
# openai_api_key: sk-...       # For Codex (OpenAI)

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

### Task File Formats

TAKT supports batch processing with task files in `.takt/tasks/`. Both `.yaml`/`.yml` and `.md` file formats are supported.

**YAML format** (recommended, supports worktree/branch/piece options):

```yaml
# .takt/tasks/add-auth.yaml
task: "Add authentication feature"
worktree: true                  # Execute in isolated shared clone
branch: "feat/add-auth"         # Branch name (auto-generated if omitted)
piece: "default"             # Piece specification (uses current if omitted)
```

**Markdown format** (simple, backward compatible):

```markdown
# .takt/tasks/add-login-feature.md

Add login feature to the application.

Requirements:
- Username and password fields
- Form validation
- Error handling on failure
```

#### Isolated Execution with Shared Clone

Specifying `worktree` in YAML task files executes each task in an isolated clone created with `git clone --shared`, keeping your main working directory clean:

- `worktree: true` - Auto-create shared clone in adjacent directory (or location specified by `worktree_dir` config)
- `worktree: "/path/to/dir"` - Create at specified path
- `branch: "feat/xxx"` - Use specified branch (auto-generated as `takt/{timestamp}-{slug}` if omitted)
- Omit `worktree` - Execute in current directory (default)

> **Note**: The YAML field name remains `worktree` for backward compatibility. Internally, it uses `git clone --shared` instead of `git worktree`. Git worktrees have a `.git` file containing `gitdir:` pointing to the main repository, which Claude Code follows to recognize the main repository as the project root. Shared clones have an independent `.git` directory, preventing this issue.

Clones are ephemeral. After task completion, they auto-commit + push, then delete the clone. Branches are the only persistent artifacts. Use `takt list` to list, merge, or delete branches.

### Session Logs

TAKT writes session logs in NDJSON (`.jsonl`) format to `.takt/logs/`. Each record is atomically appended, so partial logs are preserved even if the process crashes, and you can track in real-time with `tail -f`.

- `.takt/logs/latest.json` - Pointer to current (or latest) session
- `.takt/logs/previous.json` - Pointer to previous session
- `.takt/logs/{sessionId}.jsonl` - NDJSON session log per piece execution

Record types: `piece_start`, `step_start`, `step_complete`, `piece_complete`, `piece_abort`

Agents can read `previous.json` to inherit context from the previous execution. Session continuation is automatic — just run `takt "task"` to continue from the previous session.

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

movements:
  - name: analyze
    agent: ~/.takt/agents/my-agents/analyzer.md
    edit: false
    rules:
      - condition: Analysis complete
        next: implement
    instruction_template: |
      Thoroughly analyze this request.

  - name: implement
    agent: ~/.takt/agents/default/coder.md
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

### Specifying Agents by Path

In piece definitions, specify agents using file paths:

```yaml
# Relative path from piece file
agent: ../agents/default/coder.md

# Home directory
agent: ~/.takt/agents/default/coder.md

# Absolute path
agent: /path/to/custom/agent.md
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
| `{report_dir}` | Report directory path (e.g., `.takt/reports/20250126-143052-task-summary`) |
| `{report:filename}` | Expands to `{report_dir}/filename` (e.g., `{report:00-plan.md}`) |

### Piece Design

Elements needed for each piece movement:

**1. Agent** - Markdown file containing system prompt:

```yaml
agent: ../agents/default/coder.md    # Path to agent prompt file
agent_name: coder                    # Display name (optional)
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
| `report` | - | Auto-generated report file settings (name, format) |

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

- [Piece Guide](./docs/pieces.md) - Creating and customizing pieces
- [Agent Guide](./docs/agents.md) - Configuring custom agents
- [Changelog](../CHANGELOG.md) - Version history
- [Security Policy](../SECURITY.md) - Vulnerability reporting
- [Blog: TAKT - AI Agent Orchestration](https://zenn.dev/nrs/articles/c6842288a526d7) - Design philosophy and practical usage guide (Japanese)

## License

MIT - See [LICENSE](../LICENSE) for details.
