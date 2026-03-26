# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md) | 💬 [Discord Community](https://discord.gg/R2Xz3uYWxD)

**T**AKT **A**gent **K**oordination **T**opology — Give your AI coding agents structured review loops, managed prompts, and guardrails — so they deliver quality code, not just code.

TAKT runs AI agents (Claude Code, Codex, OpenCode, Cursor, GitHub Copilot CLI) through YAML-defined workflows with built-in review cycles. You talk to AI to define what you want, queue tasks, and let TAKT handle the execution — planning, implementation, multi-stage review, and fix loops — all governed by declarative piece files.

TAKT is built with TAKT itself (dogfooding).

## Why TAKT

**Batteries included** — Architecture, security, and AI antipattern review criteria are built in. Ship code that meets a quality bar from day one.

**Practical** — A tool for daily development, not demos. Talk to AI to refine requirements, queue tasks, and run them. Worktree isolation on task execution, PR creation, and retry on failure.

**Reproducible** — Execution paths are declared in YAML, keeping results consistent. Pieces are shareable — a workflow built by one team member can be used by anyone else to run the same quality process. Every step is logged in NDJSON for full traceability from task to PR.

**Multi-agent** — Orchestrate multiple agents with different personas, permissions, and review criteria. Run parallel reviewers, route failures back to implementers, aggregate results with declarative rules. Prompts are managed as independent facets (persona, policy, knowledge, instruction) that compose freely across workflows ([Faceted Prompting](./docs/faceted-prompting.md)).

## Requirements

Choose one:

- **Provider CLIs**: [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai), [Cursor Agent](https://docs.cursor.com/), or [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed
- **Direct API**: Anthropic / OpenAI / OpenCode API Key (no CLI required)

Optional:

- [GitHub CLI](https://cli.github.com/) (`gh`) — for `takt #N` (GitHub Issue tasks)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) — for GitLab Issue/MR integration (auto-detected from remote URL)

> **OAuth and API key usage:** Whether OAuth or API key access is permitted varies by provider and use case. Check each provider's terms of service before using TAKT.

## Quick Start

### Install

```bash
npm install -g takt
```

### Talk to AI and queue tasks

```
$ takt

Select piece:
  ❯ 🎼 default (current)
    📁 🚀 Quick Start/
    📁 🎨 Frontend/
    📁 ⚙️ Backend/

> Add user authentication with JWT

[AI clarifies requirements and organizes the task]

> /go

Proposed task:
  ...

What would you like to do?
    Execute now
    Create GitHub Issue
  ❯ Queue as task          # ← normal flow
    Continue conversation
```

Choosing "Queue as task" saves the task to `.takt/tasks/`. Run `takt run` to execute — TAKT creates an isolated worktree, runs the piece (plan → implement → review → fix loop), and offers to create a PR when done.

```bash
# Execute queued tasks
takt run

# You can also queue from GitHub Issues
takt add #6
takt add #12

# Execute all pending tasks
takt run
```

> **"Execute now"** runs the piece directly in your current directory without worktree isolation. Useful for quick experiments, but note that changes go straight into your working tree.

### Manage results

```bash
# List completed/failed task branches — merge, retry, or delete
takt list
```

## How It Works

TAKT uses a music metaphor — the name itself comes from the German word for "beat" or "baton stroke," used in conducting to keep an orchestra in time. In TAKT, a **piece** is a workflow and a **movement** is a step within it, just as a musical piece is composed of movements.

A piece defines a sequence of movements. Each movement specifies a persona (who), permissions (what's allowed), and rules (what happens next). Here's a minimal example:

```yaml
name: plan-implement-review
initial_movement: plan
max_movements: 10

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
    required_permission_mode: edit
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
| `default` | Standard development. Test-first with AI antipattern review and parallel review (architecture + supervisor). |
| `frontend-mini` | Frontend-focused mini configuration. |
| `backend-mini` | Backend-focused mini configuration. |
| `dual-mini` | Frontend + backend mini configuration. |

See the [Builtin Catalog](./docs/builtin-catalog.md) for all pieces and personas.

## Key Commands

| Command | Description |
|---------|-------------|
| `takt` | Talk to AI, refine requirements, execute or queue tasks |
| `takt run` | Execute all pending tasks |
| `takt list` | Manage task branches (merge, retry, instruct, delete) |
| `takt #N` | Execute GitHub Issue as task |
| `takt eject` | Copy builtin pieces/facets for customization |
| `takt repertoire add` | Install a repertoire package from GitHub |

See the [CLI Reference](./docs/cli-reference.md) for all commands and options.

## Configuration

Minimal `~/.takt/config.yaml`:

```yaml
provider: claude    # claude, codex, opencode, cursor, or copilot
model: sonnet       # passed directly to provider
language: en        # en or ja
```

Or use API keys directly (no CLI installation required for Claude, Codex, OpenCode):

```bash
export TAKT_ANTHROPIC_API_KEY=sk-ant-...   # Anthropic (Claude)
export TAKT_OPENAI_API_KEY=sk-...          # OpenAI (Codex)
export TAKT_OPENCODE_API_KEY=...           # OpenCode
export TAKT_CURSOR_API_KEY=...             # Cursor Agent (optional if logged in)
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...   # GitHub Copilot CLI
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
├── facets/                 # User facets (personas, policies, knowledge, etc.)
└── repertoire/             # Installed repertoire packages

.takt/                      # Project-level
├── config.yaml             # Project config
├── facets/                 # Project facets
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
engine.on('movement:complete', (movement, response) => {
  console.log(`${movement.name}: ${response.status}`);
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
| [Repertoire Packages](./docs/repertoire.md) | Installing and sharing packages |
| [Task Management](./docs/task-management.md) | Task queuing, execution, isolation |
| [Data Flow](./docs/data-flow.md) | Internal data flow and architecture diagrams |
| [CI/CD Integration](./docs/ci-cd.md) | GitHub Actions and pipeline mode |
| [Provider Sandbox & Permissions](./docs/provider-sandbox.md) | Sandbox, permission modes, and network access for Codex / OpenCode / Claude |
| [Changelog](./CHANGELOG.md) ([日本語](./docs/CHANGELOG.ja.md)) | Version history |
| [Security Policy](./SECURITY.md) | Vulnerability reporting |

## Community

Join the [TAKT Discord](https://discord.gg/R2Xz3uYWxD) for questions, discussions, and updates.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT — See [LICENSE](./LICENSE) for details.
