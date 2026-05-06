# TAKT

🇯🇵 [日本語ドキュメント](./docs/README.ja.md) | 💬 [Discord Community](https://discord.gg/R2Xz3uYWxD)

**T**AKT **A**gent **K**oordination **T**opology — Give your AI coding agents structured review loops, managed prompts, and guardrails — so they deliver quality code, not just code.

TAKT runs AI agents (Claude Code, Codex, OpenCode, Cursor, GitHub Copilot CLI) through YAML-defined workflows with built-in review cycles. You talk to AI to define what you want, queue tasks, and let TAKT handle the execution — planning, implementation, multi-stage review, and fix loops — all governed by declarative workflow files.

TAKT is built with TAKT itself (dogfooding).

## Why TAKT

**Batteries included** — Architecture, security, and AI antipattern review criteria are built in. Ship code that meets a quality bar from day one.

**Practical** — A tool for daily development, not demos. Talk to AI to refine requirements, queue tasks, and run them. Worktree isolation on task execution, PR creation, and retry on failure.

**Reproducible** — Execution paths are declared in YAML, keeping results consistent. Workflows are shareable — a workflow built by one team member can be used by anyone else to run the same quality process. Every step is logged in NDJSON for full traceability from task to PR.

**Multi-agent** — Orchestrate multiple agents with different personas, permissions, and review criteria. Run parallel reviewers, route failures back to implementers, aggregate results with declarative rules. Prompts are managed as independent facets (persona, policy, knowledge, instruction) that compose freely across workflows ([Faceted Prompting](./docs/faceted-prompting.md)).

## Requirements

Choose one:

- **Provider CLIs**: [Claude Code](https://claude.ai/code) (default `claude` provider), [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai), [Cursor Agent](https://docs.cursor.com/), or [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed
- **Direct API**: OpenAI / OpenCode API Key (no CLI required)

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

Select workflow:
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

Choosing "Queue as task" saves the task to `.takt/tasks/`. Run `takt run` to execute — TAKT creates an isolated worktree, runs the workflow (plan → implement → review → fix loop), and offers to create a PR when done.

```bash
# Execute queued tasks
takt run

# You can also queue from GitHub Issues
takt add #6
takt add #12

# Execute all pending tasks
takt run
```

> **"Execute now"** runs the workflow directly in your current directory without worktree isolation. Useful for quick experiments, but note that changes go straight into your working tree.

### Manage results

```bash
# List task branches — merge, retry, force-fail, or delete
takt list
```

## How It Works

TAKT uses a music metaphor — the name itself comes from the German word for "beat" or "baton stroke," used in conducting to keep an orchestra in time. TAKT uses **workflow** and **step** consistently in both user-facing and implementation-facing terminology.

A workflow is defined by a sequence of steps. Use `steps`, `initial_step`, and `max_steps`. Each step specifies a persona (who), permissions (what's allowed), and rules (what happens next). Here's a minimal example:

```yaml
name: plan-implement-review
initial_step: plan
max_steps: 10

steps:
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

Rules determine the next step. `COMPLETE` ends the workflow successfully, `ABORT` ends with failure. See the [Workflow Guide](./docs/workflows.md) for the full schema, parallel steps, and rule condition types.

Workflow files live in `workflows/` as the official directory name.

When the same workflow name exists in multiple locations, TAKT resolves in this order: `.takt/workflows/` → `~/.takt/workflows/` → builtins.

## Recommended Workflows

| Workflow | Use Case |
|-------|----------|
| `default` | Standard development. Test-first with AI antipattern review and parallel review (architecture + supervisor). |
| `frontend-mini` | Frontend-focused mini configuration. |
| `backend-mini` | Backend-focused mini configuration. |
| `dual-mini` | Frontend + backend mini configuration. |

See the [Builtin Catalog](./docs/builtin-catalog.md) for all workflows and personas.

## Key Commands

| Command | Description |
|---------|-------------|
| `takt` | Talk to AI, refine requirements, execute or queue tasks |
| `takt run` | Execute all pending tasks |
| `takt list` | Manage task branches (merge, retry, force-fail, instruct, delete) |
| `takt #N` | Execute GitHub Issue as task |
| `takt eject` | Copy builtin workflows/facets for customization |
| `takt workflow init` | Create a new workflow scaffold |
| `takt workflow doctor` | Validate workflow definitions |
| `takt repertoire add` | Install a repertoire package from GitHub |

See the [CLI Reference](./docs/cli-reference.md) for all commands and options.

## Configuration

Minimal `~/.takt/config.yaml`:

```yaml
provider: claude    # claude, claude-sdk, codex, opencode, cursor, or copilot
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

### Custom workflows

```bash
takt workflow init my-flow   # Create a new workflow scaffold
takt workflow doctor my-flow # Validate a workflow definition
takt eject default           # Copy builtin workflow to ~/.takt/workflows/ and edit
```

### Custom personas

Create a Markdown file in `~/.takt/personas/`:

```markdown
# ~/.takt/personas/my-reviewer.md
You are a code reviewer specialized in security.
```

Reference it in your workflow: `persona: my-reviewer`

See the [Workflow Guide](./docs/workflows.md) and [Agent Guide](./docs/agents.md) for details.

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
├── workflows/              # User workflow definitions
├── facets/                 # User facets (personas, policies, knowledge, etc.)
└── repertoire/             # Installed repertoire packages

.takt/                      # Project-level
├── config.yaml             # Project config
├── workflows/              # Project workflow overrides
├── facets/                 # Project facets
├── tasks.yaml              # Pending tasks
├── tasks/                  # Task specifications
└── runs/                   # Execution reports, logs, context
```

Workflow definitions are stored under `workflows/`.

## API Usage

```typescript
import { WorkflowEngine, loadWorkflow } from 'takt';

const config = loadWorkflow('default', process.cwd());
if (!config) throw new Error('Workflow not found');

const engine = new WorkflowEngine(config, process.cwd(), 'My task');
await engine.run();
```


## FAQ

### 通用问题

**Q: TAKT 是什么？**
TAKT（TAKT Agent Koordination Topology）是一个 AI Agent 编排工具，通过 YAML 定义的工作流让 AI 编码 Agent（如 Claude Code、Codex、OpenCode 等）执行结构化的开发流程，包含规划、实现、审查和修复循环。

**Q: TAKT 与其他 Agent 框架（如 LangChain、CrewAI）有什么区别？**
TAKT 专注于 AI 编码 Agent 的工作流编排，提供内置的代码审查循环、工作树隔离、PR 自动创建等功能。它不是通用的 Agent 框架，而是为日常开发场景设计的实用工具。

**Q: TAKT 支持哪些 AI 提供商？**
支持 Claude Code（默认）、Codex、OpenCode、Cursor Agent 和 GitHub Copilot CLI。也支持直接使用 OpenAI/OpenCode API Key，无需 CLI。

### 安装与配置

**Q: 如何安装 TAKT？**
```bash
npm install -g takt
```

**Q: 需要哪些前置条件？**
需要安装至少一个支持的 Provider CLI（Claude Code/Codex/OpenCode/Cursor/Copilot CLI），或使用 OpenAI/OpenCode API Key。可选安装 GitHub CLI (`gh`) 用于 GitHub Issue 集成。

**Q: 配置文件在哪里？**
全局配置在 `~/.takt/config.yaml`，项目配置在 `.takt/config.yaml`。

### 使用指南

**Q: 如何开始使用？**
1. 安装后运行 `takt` 进入交互模式
2. 选择工作流并与 AI 对话定义任务
3. 选择 "Queue as task" 保存任务
4. 运行 `takt run` 执行任务

**Q: 什么是工作树隔离？**
TAKT 在执行任务时会创建隔离的 Git worktree，确保任务执行不会影响主工作目录。任务完成后可以选择创建 PR。

**Q: 如何从 GitHub Issue 创建任务？**
使用 `takt add #N` 命令（N 为 Issue 编号），TAKT 会自动将 Issue 内容转换为任务。

### 工作流与自定义

**Q: 如何创建工作流？**
工作流是 YAML 文件，定义了一系列步骤（steps），每个步骤包含 persona（角色）、permissions（权限）和 rules（规则）。详见 [Workflow Guide](./docs/workflows.md)。

**Q: 可以自定义 Agent 角色吗？**
可以。TAKT 使用 "Faceted Prompting" 方法论，将提示词分解为 persona、policy、knowledge、instruction 等独立面，可以自由组合。详见 [Faceted Prompting](./docs/faceted-prompting.md)。

### 故障排查

**Q: 任务执行失败怎么办？**
TAKT 支持失败重试。使用 `takt list` 查看任务分支状态，可以选择 retry、force-fail 或删除。

**Q: 如何查看执行日志？**
执行日志存储在 `.takt/runs/` 目录下，格式为 NDJSON，支持从任务到 PR 的完整追溯。

**Q: 遇到 OAuth 或 API Key 相关问题？**
各 Provider 对 OAuth 和 API Key 的使用政策不同，请参考各 Provider 的服务条款。如遇到问题，可在 [TAKT Discord](https://discord.gg/R2Xz3uYWxD) 社区寻求帮助。
## Documentation

| Document | Description |
|----------|-------------|
| [CLI Reference](./docs/cli-reference.md) | All commands and options |
| [Configuration](./docs/configuration.md) | Global and project settings |
| [Workflow Guide](./docs/workflows.md) | Creating and customizing workflows |
| [Agent Guide](./docs/agents.md) | Custom agent configuration |
| [Builtin Catalog](./docs/builtin-catalog.md) | All builtin workflows and personas |
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
