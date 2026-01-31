# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md)

**T**ask **A**gent **K**oordination **T**ool - Multi-agent orchestration system for Claude Code and OpenAI Codex.

TAKT is built with TAKT (dogfooding).

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or Codex must be installed and configured
- [GitHub CLI](https://cli.github.com/) (`gh`) — required only for `takt #N` (GitHub Issue execution)

TAKT supports both Claude Code and Codex as providers; you can choose the provider during setup.

## Installation

```bash
npm install -g takt
```

## Quick Start

```bash
# Run a task (prompts for workflow selection, worktree, and PR creation)
takt "Add a login feature"

# Run a GitHub issue as a task (both are equivalent)
takt '#6'
takt --issue 6

# Interactive mode — refine task requirements with AI, then execute
takt

# Pipeline mode (non-interactive, for scripts and CI)
takt --task "fix the auth bug" --auto-pr
```

### What happens when you run a task

When you run `takt "Add a login feature"`, TAKT guides you through an interactive flow:

**1. Workflow selection**

```
Select workflow:
  (↑↓ to move, Enter to select)

  ❯ default (current) (default)
    expert
    expert-cqrs
    magi
    research
    simple
    Cancel
```

**2. Isolated clone** (optional)

```
? Create worktree? (Y/n)
```

Choose `y` to run in a `git clone --shared` isolated environment, keeping your working directory clean.

**3. Execution** — The selected workflow orchestrates multiple agents to complete the task.

**4. PR creation** (after worktree execution)

```
? Create pull request? (y/N)
```

If `--auto-pr` is specified, the PR is created automatically without asking.

### Recommended workflows

| Workflow | Best for |
|----------|----------|
| `default` | Full development tasks. Used for TAKT's own development. Multi-stage review with parallel architect + security review. |
| `simple` | Lightweight tasks like README updates or small fixes. Reviews without fix loops. |
| `expert` / `expert-cqrs` | Web development projects. Sequential multi-expert review with fix loops (`expert`: Architecture, Frontend, Security, QA; `expert-cqrs`: CQRS+ES, Frontend, Security, QA). |
| `research` | Research and investigation. Autonomous research without asking questions. |
| `magi` | Fun deliberation. Three AI personas analyze and vote (Evangelion-inspired). |

## Commands

### Interactive Mode (default)

The standard mode for everyday development. Workflow selection, worktree creation, and PR creation are handled interactively.

```bash
# Run a task
takt "Add a login feature"

# Run a GitHub issue as a task (both are equivalent)
takt '#6'
takt --issue 6

# Interactive mode — refine task requirements with AI before executing
takt

# Run a task and automatically create a PR (skip the confirmation prompt)
takt '#6' --auto-pr
```

When `--auto-pr` is not specified, you will be asked whether to create a PR after a successful worktree execution.

### Pipeline Mode (`--task`)

Specifying `--task` enters pipeline mode — fully non-interactive, suitable for scripts and CI integration. TAKT automatically creates a branch, runs the workflow, commits, and pushes.

```bash
# Run a task in pipeline mode
takt --task "fix the auth bug"

# Pipeline mode + automatic PR creation
takt --task "fix the auth bug" --auto-pr

# Attach GitHub issue context
takt --task "fix the auth bug" --issue 99 --auto-pr

# Specify workflow and branch
takt --task "fix the auth bug" -w magi -b feat/fix-auth

# Specify repository (for PR creation)
takt --task "fix the auth bug" --auto-pr --repo owner/repo

# Run workflow only — skip branch creation, commit, and push
takt --task "fix the auth bug" --skip-git
```

In pipeline mode, PRs are **not** created unless `--auto-pr` is explicitly specified.

### Subcommands

| Command | Description |
|---------|-------------|
| `takt run` | Run all pending tasks from `.takt/tasks/` |
| `takt watch` | Watch `.takt/tasks/` and auto-execute tasks (stays resident) |
| `takt add` | Add a new task via AI conversation |
| `takt list` | List task branches (try merge, merge & cleanup, or delete) |
| `takt switch` | Switch workflow interactively |
| `takt clear` | Clear agent conversation sessions |
| `takt eject` | Copy builtin workflow/agents to `~/.takt/` for customization |
| `takt config` | Configure permission mode |
| `takt --help` | Show help |

### Options

| Option | Description |
|--------|-------------|
| `-t, --task <text>` | Task content — **triggers pipeline (non-interactive) mode** |
| `-i, --issue <N>` | GitHub issue number (equivalent to `#N` in interactive mode) |
| `-w, --workflow <name>` | Workflow to use |
| `-b, --branch <name>` | Branch name (auto-generated if omitted) |
| `--auto-pr` | Create PR after execution (interactive: skip confirmation, pipeline: enable PR) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, workflow-only) |
| `--repo <owner/repo>` | Repository for PR creation |

## Workflows

TAKT uses YAML-based workflow definitions with rule-based routing. Builtin workflows are embedded in the package; user workflows in `~/.takt/workflows/` take priority. Use `takt eject` to copy a builtin to `~/.takt/` for customization.

### Example Workflow

```yaml
name: default
max_iterations: 10
initial_step: plan

steps:
  - name: plan
    agent: ../agents/default/planner.md
    model: opus
    edit: false
    rules:
      - condition: Plan complete
        next: implement
    instruction_template: |
      Analyze the request and create an implementation plan.

  - name: implement
    agent: ../agents/default/coder.md
    edit: true
    permission_mode: acceptEdits
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
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
      Review the implementation for architecture and code quality.
```

### Parallel Steps

Steps can execute sub-steps concurrently with aggregate evaluation:

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

- `all("X")`: true if ALL sub-steps matched condition X
- `any("X")`: true if ANY sub-step matched condition X
- Sub-step `rules` define possible outcomes; `next` is optional (parent handles routing)

### Rule Condition Types

| Type | Syntax | Description |
|------|--------|-------------|
| Tag-based | `"condition text"` | Agent outputs `[STEP:N]` tag, matched by index |
| AI judge | `ai("condition text")` | AI evaluates the condition against agent output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-step results |

## Built-in Workflows

TAKT ships with several built-in workflows:

| Workflow | Description |
|----------|-------------|
| `default` | Full development workflow: plan → implement → AI review → parallel reviewers (architect + security) → supervisor approval. Includes fix loops for each review stage. |
| `simple` | Simplified version of default: plan → implement → architect review → AI review → supervisor. No intermediate fix steps. |
| `research` | Research workflow: planner → digger → supervisor. Autonomously researches topics without asking questions. |
| `expert` | Sequential review with domain experts: Architecture, Frontend, Security, QA reviews with fix loops. |
| `expert-cqrs` | Sequential review with domain experts: CQRS+ES, Frontend, Security, QA reviews with fix loops. |
| `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |

Switch between workflows with `takt switch`.

## Built-in Agents

| Agent | Description |
|-------|-------------|
| **planner** | Task analysis, spec investigation, and implementation planning |
| **coder** | Implements features and fixes bugs |
| **ai-antipattern-reviewer** | Reviews for AI-specific anti-patterns (hallucinated APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Reviews architecture and code quality, verifies spec compliance |
| **security-reviewer** | Security vulnerability assessment |
| **supervisor** | Final verification, validation, and approval |

## Custom Agents

Define custom agents in `.takt/agents.yaml`:

```yaml
agents:
  - name: my-reviewer
    prompt_file: .takt/prompts/reviewer.md
    allowed_tools: [Read, Glob, Grep]
    provider: claude             # Optional: claude or codex
    model: opus                  # Claude: opus/sonnet/haiku or full name (claude-opus-4-5-20251101)
```

Or create agent prompt files as Markdown:

```markdown
# ~/.takt/agents/my-agents/reviewer.md

You are a code reviewer focused on security.

## Your Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic
```

## Model Selection

The `model` field in workflow steps, agent configs, and global config is passed directly to the provider (Claude Code CLI or Codex SDK). TAKT does not resolve model aliases — the provider handles that.

### Claude Code

Claude Code supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). See [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

### Codex

The model string is passed to the Codex SDK. Defaults to `codex` if not specified. See Codex documentation for available models.

## Project Structure

```
~/.takt/
├── config.yaml          # Global config (provider, model, workflows, etc.)
├── workflows/           # User workflow definitions (override builtins)
└── agents/              # User agent prompt files

.takt/                   # Project-level config
├── agents.yaml          # Custom agent definitions
├── tasks/               # Pending task files (.yaml, .md)
├── completed/           # Completed tasks with reports
├── reports/             # Execution reports (auto-generated)
└── logs/                # Session logs in NDJSON format
    ├── latest.json      # Pointer to current/latest session
    ├── previous.json    # Pointer to previous session
    └── {sessionId}.jsonl # NDJSON session log per workflow run
```

Builtin resources are embedded in the npm package (`dist/resources/`). User files in `~/.takt/` take priority.

### Global Configuration

Configure default provider and model in `~/.takt/config.yaml`:

```yaml
# ~/.takt/config.yaml
language: en
default_workflow: default
log_level: info
provider: claude         # Default provider: claude or codex
model: sonnet            # Default model (optional)
trusted_directories:
  - /path/to/trusted/dir

# Pipeline execution settings (optional)
# Customize branch naming, commit messages, and PR body for pipeline mode.
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}
```

**Pipeline template variables:**

| Variable | Available in | Description |
|----------|-------------|-------------|
| `{title}` | commit message | Issue title |
| `{issue}` | commit message, PR body | Issue number |
| `{issue_body}` | PR body | Issue body text |
| `{report}` | PR body | Workflow execution report |

**Model Resolution Priority:**
1. Workflow step `model` (highest priority)
2. Custom agent `model`
3. Global config `model`
4. Provider default (Claude: sonnet, Codex: gpt-5.2-codex)


## Practical Usage Guide

### Interactive Workflow

When running `takt "Add a feature"`, you are prompted to:

1. **Select a workflow** - Choose from available workflows (arrow keys, ESC to cancel)
2. **Create an isolated clone** (optional) - Run the task in a `git clone --shared` for isolation
3. **Create a pull request** (after worktree execution) - Create a PR from the task branch

If `--auto-pr` is specified, the PR confirmation is skipped and the PR is created automatically.

### Adding Custom Workflows

Create your own workflow by adding YAML files to `~/.takt/workflows/`, or use `/eject` to customize a builtin:

```bash
# Copy the default workflow to ~/.takt/workflows/ for editing
takt eject default
```

```yaml
# ~/.takt/workflows/my-workflow.yaml
name: my-workflow
description: My custom workflow
max_iterations: 5
initial_step: analyze

steps:
  - name: analyze
    agent: ~/.takt/agents/my-agents/analyzer.md
    edit: false
    rules:
      - condition: Analysis complete
        next: implement
    instruction_template: |
      Analyze this request thoroughly.

  - name: implement
    agent: ~/.takt/agents/default/coder.md
    edit: true
    permission_mode: acceptEdits
    pass_previous_response: true
    rules:
      - condition: Done
        next: COMPLETE
    instruction_template: |
      Implement based on the analysis.
```

> **Note**: `{task}`, `{previous_response}`, and `{user_inputs}` are auto-injected into instructions. You only need explicit placeholders if you want to control their position in the template.

### Specifying Agents by Path

Agents are specified using file paths in workflow definitions:

```yaml
# Relative to workflow file directory
agent: ../agents/default/coder.md

# Home directory
agent: ~/.takt/agents/default/coder.md

# Absolute paths
agent: /path/to/custom/agent.md
```

### Task Management

TAKT supports batch task processing through task files in `.takt/tasks/`. Both `.yaml`/`.yml` and `.md` file formats are supported.

#### Adding Tasks with `takt add`

```bash
# Start AI conversation to define and add a task
takt add
```

The `takt add` command starts an AI conversation where you discuss and refine your task requirements. After confirming with `/go`, the AI summarizes the conversation and creates a YAML task file with optional worktree/branch/workflow settings.

#### Task File Formats

**YAML format** (recommended, supports worktree/branch/workflow options):

```yaml
# .takt/tasks/add-auth.yaml
task: "Add authentication feature"
worktree: true                  # Run in isolated shared clone
branch: "feat/add-auth"         # Branch name (auto-generated if omitted)
workflow: "default"             # Workflow override (uses current if omitted)
```

**Markdown format** (simple, backward compatible):

```markdown
# .takt/tasks/add-login-feature.md

Add a login feature to the application.

Requirements:
- Username and password fields
- Form validation
- Error handling for failed attempts
```

#### Isolated Execution (Shared Clone)

YAML task files can specify `worktree` to run each task in an isolated `git clone --shared`, keeping the main working directory clean:

- `worktree: true` - Auto-create a shared clone in a sibling directory (or `worktree_dir` from config)
- `worktree: "/path/to/dir"` - Create at specified path
- `branch: "feat/xxx"` - Use specified branch (auto-generated as `takt/{timestamp}-{slug}` if omitted)
- Omit `worktree` - Run in current working directory (default)

> **Note**: The YAML field is named `worktree` for backward compatibility. Internally, `git clone --shared` is used instead of `git worktree` because git worktrees have a `.git` file with `gitdir:` that points back to the main repository, causing Claude Code to recognize the main repo as the project root. Shared clones have an independent `.git` directory that avoids this issue.

Clones are ephemeral. When a task completes successfully, TAKT automatically commits all changes and pushes the branch to the main repository, then deletes the clone. Use `takt list` to list, try-merge, or delete task branches.

#### Running Tasks with `/run-tasks`

```bash
takt run
```

- Tasks are executed in alphabetical order (use prefixes like `001-`, `002-` for ordering)
- Completed tasks are moved to `.takt/completed/` with execution reports
- New tasks added during execution will be picked up dynamically

#### Watching Tasks with `/watch`

```bash
takt watch
```

Watch mode polls `.takt/tasks/` for new task files and auto-executes them as they appear. The process stays resident until `Ctrl+C`. This is useful for:
- CI/CD pipelines that generate task files
- Automated workflows where tasks are added by external processes
- Long-running development sessions where tasks are queued over time

#### Listing Task Branches with `/list-tasks`

```bash
takt list
```

Lists all `takt/`-prefixed branches with file change counts. For each branch you can:
- **Try merge** - Squash merge into main (stage changes without committing)
- **Instruct** - Give additional instructions via a temporary clone
- **Merge & cleanup** - Merge and delete the branch
- **Delete** - Delete the branch without merging

### Session Logs

TAKT writes session logs in NDJSON (`.jsonl`) format to `.takt/logs/`. Each record is appended atomically, so even if the process crashes mid-execution, partial logs are preserved and logs can be tailed in real-time with `tail -f`.

- `.takt/logs/latest.json` - Pointer to the current (or most recent) session
- `.takt/logs/previous.json` - Pointer to the previous session
- `.takt/logs/{sessionId}.jsonl` - NDJSON session log with step history

Record types: `workflow_start`, `step_start`, `step_complete`, `workflow_complete`, `workflow_abort`.

Agents can read `previous.json` to pick up context from a prior run. Session continuity is automatic — simply run `takt "task"` to continue where the previous session left off.

### Workflow Variables

Available variables in `instruction_template`:

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Workflow-wide turn count (total steps executed) |
| `{max_iterations}` | Maximum iterations allowed |
| `{step_iteration}` | Per-step iteration count (how many times THIS step has run) |
| `{previous_response}` | Previous step's output (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during workflow (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/reports/20250126-143052-task-summary`) |
| `{report:filename}` | Resolves to `{report_dir}/filename` (e.g., `{report:00-plan.md}`) |

### Designing Workflows

Each workflow step requires:

**1. Agent** - A Markdown file containing the system prompt:

```yaml
agent: ../agents/default/coder.md    # Path to agent prompt file
agent_name: coder                    # Display name (optional)
```

**2. Rules** - Define how the step routes to the next step. The instruction builder auto-injects status output rules so agents know what tags to output:

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Cannot proceed"
    next: ABORT
```

Special `next` values: `COMPLETE` (success), `ABORT` (failure).

**3. Step options:**

| Option | Default | Description |
|--------|---------|-------------|
| `edit` | - | Whether the step can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous step's output to `{previous_response}` |
| `allowed_tools` | - | List of tools the agent can use (Read, Glob, Grep, Edit, Write, Bash, etc.) |
| `provider` | - | Override provider for this step (`claude` or `codex`) |
| `model` | - | Override model for this step |
| `permission_mode` | `default` | Permission mode: `default`, `acceptEdits`, or `bypassPermissions` |
| `report` | - | Report file configuration (name, format) for auto-generated reports |

## API Usage

```typescript
import { WorkflowEngine, loadWorkflow } from 'takt';  // npm install takt

const config = loadWorkflow('default');
if (!config) {
  throw new Error('Workflow not found');
}
const engine = new WorkflowEngine(config, process.cwd(), 'My task');

engine.on('step:complete', (step, response) => {
  console.log(`${step.name}: ${response.status}`);
});

await engine.run();
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## Docker Support

Docker environment is provided for testing in other environments:

```bash
# Build Docker images
docker compose build

# Run tests in container
docker compose run --rm test

# Run lint in container
docker compose run --rm lint

# Build only (skip tests)
docker compose run --rm build
```

This ensures the project works correctly in a clean Node.js 20 environment.

## Documentation

- [Workflow Guide](./docs/workflows.md) - Create and customize workflows
- [Agent Guide](./docs/agents.md) - Configure custom agents
- [Changelog](./CHANGELOG.md) - Version history
- [Security Policy](./SECURITY.md) - Vulnerability reporting
- [Blog: TAKT - AI Agent Orchestration](https://zenn.dev/nrs/articles/c6842288a526d7) - Design philosophy and practical usage guide (Japanese)

## License

MIT - See [LICENSE](./LICENSE) for details.
Test completed at Sun Feb  1 01:53:23 JST 2026
