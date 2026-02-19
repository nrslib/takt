# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md)

**T**AKT **A**gent **K**oordination **T**opology — Give your AI coding agents structured review loops, managed prompts, and guardrails — so they deliver quality code, not just code.

TAKT runs AI agents (Claude Code, Codex, OpenCode) through YAML-defined workflows with built-in review cycles. You talk to AI to define what you want, queue tasks, and let TAKT handle the execution — planning, implementation, multi-stage review, and fix loops — all governed by declarative piece files.

TAKT is built with TAKT itself (dogfooding).

## Why TAKT

**Batteries included** — Architecture, security, and AI antipattern review criteria are built in. Ship code that meets a quality bar from day one.

**Practical** — A tool for daily development, not demos. Talk to AI to refine requirements, queue tasks, and run them. Automatic worktree isolation, PR creation, and retry on failure.

**Reproducible** — Execution paths are declared in YAML, keeping results consistent. Pieces are shareable — a workflow built by one team member can be used by anyone else to run the same quality process. Every step is logged in NDJSON for full traceability from task to PR.

**Multi-agent** — Orchestrate multiple agents with different personas, permissions, and review criteria. Run parallel reviewers, route failures back to implementers, aggregate results with declarative rules. Prompts are managed as independent facets (persona, policy, knowledge, instruction) that compose freely across workflows ([Faceted Prompting](./docs/faceted-prompting.md)).

## Requirements

Choose one:

- **Provider CLIs**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [OpenCode](https://opencode.ai) installed
- **Direct API**: Anthropic / OpenAI / OpenCode API Key (no CLI required)

Optional:

- [GitHub CLI](https://cli.github.com/) (`gh`) — for `takt #N` (GitHub Issue tasks)

## Quick Start

### Install

```bash
npm install -g takt
```

### Talk to AI, then execute

```
$ takt

Select piece:
  ❯ 🎼 default (current)
    📁 Development/
    📁 Research/

> Add user authentication with JWT

[AI clarifies requirements and organizes the task]

> /go
```

TAKT creates an isolated worktree, runs the piece (plan → implement → review → fix loop), and offers to create a PR when done.

### Queue tasks, then batch execute

Use `takt` to queue multiple tasks, then execute them all at once:

```bash
# Queue tasks through conversation
takt
> Refactor the auth module
> /go          # queues the task

# Or queue from GitHub Issues
takt add #6
takt add #12

# Execute all pending tasks
takt run
```

### Manage results

```bash
# List completed/failed task branches — merge, retry, or delete
takt list
```

## How It Works

TAKT uses a music metaphor: **piece** = workflow, **movement** = step.

A piece defines a sequence of movements. Each movement specifies a persona (who), permissions (what's allowed), and rules (what happens next). Here's a minimal example:

```yaml
name: simple
initial_movement: plan

personas:
  planner: ../personas/planner.md
  coder: ../personas/coder.md
  reviewer: ../personas/architecture-reviewer.md

movements:
  - name: plan
    persona: planner
    edit: false
    rules:
      - condition: Planning complete
        next: implement

  - name: implement
    persona: coder
    edit: true
    rules:
      - condition: Implementation complete
        next: review

  - name: review
    persona: reviewer
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement    # ← fix loop
```

Rules determine the next movement. `COMPLETE` ends the piece successfully, `ABORT` ends with failure. See the [Piece Guide](./docs/pieces.md) for the full schema, parallel movements, and rule condition types.

## Recommended Pieces

| Piece | Use Case |
|-------|----------|
| `default-mini` | Quick fixes. Lightweight plan → implement → parallel review → fix loop. |
| `frontend-mini` | Frontend-focused mini configuration. |
| `backend-mini` | Backend-focused mini configuration. |
| `expert-mini` | Expert-level mini configuration. |
| `default` | Serious development. Multi-stage review with parallel reviewers. Used for TAKT's own development. |

See the [Builtin Catalog](./docs/builtin-catalog.md) for all pieces and personas.

## Key Commands

| Command | Description |
|---------|-------------|
| `takt` | Talk to AI, refine requirements, execute or queue tasks |
| `takt run` | Execute all pending tasks |
| `takt list` | Manage task branches (merge, retry, instruct, delete) |
| `takt #N` | Execute GitHub Issue as task |
| `takt switch` | Switch active piece |
| `takt eject` | Copy builtin pieces/personas for customization |

See the [CLI Reference](./docs/cli-reference.md) for all commands and options.

## Configuration

Minimal `~/.takt/config.yaml`:

```yaml
provider: claude    # claude, codex, or opencode
model: sonnet       # passed directly to provider
language: en        # en or ja
```

Or use API keys directly (no CLI installation required):

```bash
export TAKT_ANTHROPIC_API_KEY=sk-ant-...
```

See the [Configuration Guide](./docs/configuration.md) for all options, provider profiles, and model resolution.

## Customization

### Custom pieces

```bash
takt eject default    # Copy builtin to ~/.takt/pieces/ and edit
```

### Custom personas

Create a Markdown file in `~/.takt/personas/`:

```markdown
# ~/.takt/personas/my-reviewer.md
You are a code reviewer specialized in security.
```

Reference it in your piece: `persona: my-reviewer`

See the [Piece Guide](./docs/pieces.md) and [Agent Guide](./docs/agents.md) for details.

## CI/CD

TAKT provides [takt-action](https://github.com/nrslib/takt-action) for GitHub Actions:

```yaml
- uses: nrslib/takt-action@main
  with:
    anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

For other CI systems, use pipeline mode:

```bash
takt --pipeline --task "Fix the bug" --auto-pr
```

See the [CI/CD Guide](./docs/ci-cd.md) for full setup instructions.

## Project Structure

```
~/.takt/                    # Global config
├── config.yaml             # Provider, model, language, etc.
├── pieces/                 # User piece definitions
└── personas/               # User persona prompts

.takt/                      # Project-level
├── config.yaml             # Project config
├── tasks.yaml              # Pending tasks
├── tasks/                  # Task specifications
└── runs/                   # Execution reports, logs, context
```

## API Usage

```typescript
import { PieceEngine, loadPiece } from 'takt';

const config = loadPiece('default');
if (!config) throw new Error('Piece not found');

const engine = new PieceEngine(config, process.cwd(), 'My task');
engine.on('step:complete', (step, response) => {
  console.log(`${step.name}: ${response.status}`);
});

await engine.run();
```

## Documentation

| Document | Description |
|----------|-------------|
| [CLI Reference](./docs/cli-reference.md) | All commands and options |
| [Configuration](./docs/configuration.md) | Global and project settings |
| [Piece Guide](./docs/pieces.md) | Creating and customizing pieces |
| [Agent Guide](./docs/agents.md) | Custom agent configuration |
| [Builtin Catalog](./docs/builtin-catalog.md) | All builtin pieces and personas |
| [Faceted Prompting](./docs/faceted-prompting.md) | Prompt design methodology |
| [Task Management](./docs/task-management.md) | Task queuing, execution, isolation |
| [CI/CD Integration](./docs/ci-cd.md) | GitHub Actions and pipeline mode |
| [Changelog](./CHANGELOG.md) ([日本語](./docs/CHANGELOG.ja.md)) | Version history |
| [Security Policy](./SECURITY.md) | Vulnerability reporting |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT — See [LICENSE](./LICENSE) for details.
