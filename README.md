# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md)

**T**ask **A**gent **K**oordination **T**ool - Multi-agent orchestration system for Claude Code and OpenAI Codex.

> **Note**: This project is developed at my own pace. See [Disclaimer](#disclaimer) for details.

TAKT is built with TAKT (dogfooding).

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or Codex must be installed and configured

TAKT supports both Claude Code and Codex as providers; you can choose the provider during setup.

## Installation

```bash
npm install -g takt
```

## Quick Start

```bash
# Run a task (will prompt for workflow selection)
takt "Add a login feature"

# Switch workflow
takt /switch

# Run all pending tasks
takt /run-tasks
```

## Commands

| Command | Description |
|---------|-------------|
| `takt "task"` | Execute task with workflow selection |
| `takt -r "task"` | Execute task, resuming previous session |
| `takt /run-tasks` | Run all pending tasks |
| `takt /switch` | Switch workflow interactively |
| `takt /clear` | Clear agent conversation sessions |
| `takt /help` | Show help |

## Workflows

TAKT uses YAML-based workflow definitions. Place them in:
- `~/.takt/workflows/*.yaml`

### Example Workflow

```yaml
name: default
max_iterations: 10

steps:
  - name: plan
    agent: planner
    provider: claude         # Optional: claude or codex
    model: opus              # Claude: opus/sonnet/haiku, Codex: gpt-5.2-codex/gpt-5.1-codex
    instruction_template: |
      {task}
    transitions:
      - condition: done
        next_step: implement

  - name: implement
    agent: coder
    provider: codex
    model: gpt-5.2-codex     # Codex model example
    instruction_template: |
      {task}
    transitions:
      - condition: done
        next_step: review
      - condition: blocked
        next_step: ABORT

  - name: review
    agent: architect
    model: sonnet            # Model alias (no provider = uses global default)
    transitions:
      - condition: approved
        next_step: COMPLETE
      - condition: rejected
        next_step: implement
```

## Built-in Agents

- **coder** - Implements features and fixes bugs
- **architect** - Reviews code and provides feedback
- **supervisor** - Final verification and approval

## Custom Agents

Define custom agents in `.takt/agents.yaml`:

```yaml
agents:
  - name: my-reviewer
    prompt_file: .takt/prompts/reviewer.md
    allowed_tools: [Read, Glob, Grep]
    provider: claude             # Optional: claude or codex
    model: opus                  # Claude: opus/sonnet/haiku or full name (claude-opus-4-5-20251101)
    status_patterns:
      approved: "\\[APPROVE\\]"
      rejected: "\\[REJECT\\]"

  - name: my-codex-agent
    prompt_file: .takt/prompts/analyzer.md
    provider: codex
    model: gpt-5.2-codex         # Codex: gpt-5.2-codex, gpt-5.1-codex, etc.
```

## Model Selection

### Claude Models

You can specify models using either **aliases** or **full model names**:

**Aliases** (recommended for simplicity):
- `opus` - Claude Opus 4.5 (highest reasoning capability)
- `sonnet` - Claude Sonnet 4.5 (balanced, best for most tasks)
- `haiku` - Claude Haiku 4.5 (fast and efficient)
- `opusplan` - Opus for planning, Sonnet for execution
- `default` - Recommended model for your account type

**Full model names** (recommended for production):
- `claude-opus-4-5-20251101`
- `claude-sonnet-4-5-20250929`
- `claude-haiku-4-5-20250101`

### Codex Models

Available Codex models:
- `gpt-5.2-codex` - Latest agentic coding model (default)
- `gpt-5.1-codex` - Previous generation
- `gpt-5.1-codex-max` - Optimized for long-running tasks
- `gpt-5.1-codex-mini` - Smaller, cost-effective version
- `codex-1` - Specialized model aligned with coding preferences

## Project Structure

```
~/.takt/
├── config.yaml          # Global config (provider, model, workflows, etc.)
├── workflows/           # Workflow definitions
└── agents/              # Agent prompt files
```

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
```

**Model Resolution Priority:**
1. Workflow step `model` (highest priority)
2. Custom agent `model`
3. Global config `model`
4. Provider default (Claude: sonnet, Codex: gpt-5.2-codex)


## Practical Usage Guide

### Resuming Sessions with `-r`

When TAKT prompts for additional input during execution (e.g., "Please provide more details"), use the `-r` flag to continue the conversation:

```bash
# First run - agent might ask for clarification
takt "Fix the login bug"

# Resume the same session to provide the requested information
takt -r "The bug occurs when the password contains special characters"
```

The `-r` flag preserves the agent's conversation history, allowing for natural back-and-forth interaction.

### Playing with MAGI System

MAGI is a deliberation system inspired by Evangelion. Three AI personas analyze your question from different perspectives and vote:

```bash
# Select 'magi' workflow when prompted
takt "Should we migrate from REST to GraphQL?"
```

The three MAGI personas:
- **MELCHIOR-1** (Scientist): Logical, data-driven analysis
- **BALTHASAR-2** (Nurturer): Team and human-centered perspective
- **CASPER-3** (Pragmatist): Practical, real-world considerations

Each persona votes: APPROVE, REJECT, or CONDITIONAL. The final decision is made by majority vote.

### Adding Custom Workflows

Create your own workflow by adding YAML files to `~/.takt/workflows/`:

```yaml
# ~/.takt/workflows/my-workflow.yaml
name: my-workflow
description: My custom workflow

max_iterations: 5

steps:
  - name: analyze
    agent: ~/.takt/agents/my-agents/analyzer.md
    instruction_template: |
      Analyze this request: {task}
    transitions:
      - condition: done
        next_step: implement

  - name: implement
    agent: ~/.takt/agents/default/coder.md
    instruction_template: |
      Implement based on the analysis: {previous_response}
    pass_previous_response: true
    transitions:
      - condition: done
        next_step: COMPLETE
```

### Specifying Agents by Path

Agents are specified using file paths in workflow definitions:

```yaml
# Use built-in agents
agent: ~/.takt/agents/default/coder.md
agent: ~/.takt/agents/magi/melchior.md

# Use project-local agents
agent: ./.takt/agents/my-reviewer.md

# Use absolute paths
agent: /path/to/custom/agent.md
```

Create custom agent prompts as Markdown files:

```markdown
# ~/.takt/agents/my-agents/reviewer.md

You are a code reviewer focused on security.

## Your Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic

## Output Format
- [REVIEWER:APPROVE] if code is secure
- [REVIEWER:REJECT] if issues found (list them)
```

### Using `/run-tasks` for Batch Processing

The `/run-tasks` command executes all task files in `.takt/tasks/` directory:

```bash
# Create task files as you think of them
echo "Add unit tests for the auth module" > .takt/tasks/001-add-tests.md
echo "Refactor the database layer" > .takt/tasks/002-refactor-db.md
echo "Update API documentation" > .takt/tasks/003-update-docs.md

# Run all pending tasks
takt /run-tasks
```

**How it works:**
- Tasks are executed in alphabetical order (use prefixes like `001-`, `002-` for ordering)
- Each task file should contain a description of what needs to be done
- Completed tasks are moved to `.takt/completed/` with execution reports
- New tasks added during execution will be picked up dynamically

**Task file format:**

```markdown
# .takt/tasks/add-login-feature.md

Add a login feature to the application.

Requirements:
- Username and password fields
- Form validation
- Error handling for failed attempts
```

This is perfect for:
- Brainstorming sessions where you capture ideas as files
- Breaking down large features into smaller tasks
- Automated pipelines that generate task files

### Workflow Variables

Available variables in `instruction_template`:

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request |
| `{iteration}` | Current iteration number |
| `{max_iterations}` | Maximum iterations |
| `{previous_response}` | Previous step's output (requires `pass_previous_response: true`) |
| `{user_inputs}` | Additional user inputs during workflow |
| `{git_diff}` | Current git diff (uncommitted changes) |

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

## Disclaimer

This project is a personal project developed at my own pace.

- **Response times**: I may not be able to respond to issues immediately
- **Development style**: This project is primarily developed using "vibe coding" (AI-assisted development) - **use at your own risk**
- **Pull requests**:
  - Small, focused PRs (bug fixes, typos, docs) are welcome
  - Large PRs, especially AI-generated bulk changes, are difficult to review

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.

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

## License

MIT - See [LICENSE](./LICENSE) for details.
