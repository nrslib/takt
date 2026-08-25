# TAKT

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/takt-logo-dark.svg">
    <img src="./assets/takt-logo.svg" alt="TAKT 徽标" width="480">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/takt"><img src="https://img.shields.io/npm/v/takt?label=npm" alt="npm 版本"></a>
  <a href="https://github.com/nrslib/takt/stargazers"><img src="https://img.shields.io/github/stars/nrslib/takt?logo=github&label=stars" alt="GitHub stars"></a>
  <a href="https://github.com/nrslib/takt/actions/workflows/ci.yml"><img src="https://github.com/nrslib/takt/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/github/license/nrslib/takt" alt="许可证"></a>
  <a href="https://discord.gg/R2Xz3uYWxD"><img src="https://img.shields.io/badge/dynamic/json?label=discord&query=approximate_member_count&url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FR2Xz3uYWxD%3Fwith_counts%3Dtrue&suffix=%20members&logo=discord&logoColor=white&color=5865F2" alt="Discord 成员数"></a>
</p>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://nrslib.github.io/takt/#tutorial">
    <img src="./assets/tutorial-preview.gif" alt="展示描述任务、将任务加入队列并由多个 AI 智能体执行的 TAKT 教程预览" width="720">
  </a>
</p>

**不再日夜盯着 AI 编码智能体。**

TAKT 是一个开源 CLI，可将 AI 编码智能体变成可重复的开发工作流。你可以在 YAML 中定义规划、实现、审查、修复循环、人工检查点、权限和输出契约，然后在隔离的 worktree 中执行任务并保留可追踪的日志。

你不需要让一个智能体记住整个流程；TAKT 为每个 step 分配独立的角色、上下文和转移规则。AI 负责编写代码，workflow 决定下一步做什么。

![TAKT 控制 AI 编码智能体工作流](./assets/description/01-hero.png)

- 将规划 → 实现 → 审查 → 修复循环定义为明确的 workflow step
- 通过 step 专属的 persona、policy、knowledge、instruction 和 output contract 保持上下文聚焦
- 在隔离的 worktree 中执行排队任务，并在之后查看日志和报告
- 使用 Claude Code、Claude SDK、Codex SDK、OpenCode SDK、Pi SDK、官方 DeepSeek Harness SDK、Cursor、GitHub Copilot CLI 或 Kiro 作为 provider

**T**AKT **A**gent **K**oordination **T**opology 通过审查循环、prompt 管理和按 step 划分的权限来编排多个 AI 智能体。

先和 AI 对话描述需求，再将需求加入任务队列，最后运行 `takt run`。规划、实现、审查和修复循环都定义在 YAML workflow 文件中，不会把整个流程交给智能体自行决定。TAKT 让 Claude Code、Codex、OpenCode、Pi、官方 DeepSeek Harness SDK、Cursor、GitHub Copilot CLI 和 Kiro CLI 以不同的角色、权限和上下文协作。

TAKT 主要用于 AI 编码工作流，但同样适用于任何需要多个 AI 智能体协作，或可以通过审查、判断和反馈循环提高质量的任务。

TAKT 本身也是用 TAKT 开发的（dogfooding）。

## 为什么选择 TAKT

AI 编码智能体不会自动形成稳定的开发流程。在长时间工作中，它们可能忘记指令、积累被污染的上下文、混淆实现与审查职责，还会迫使人类反复提出相同的反馈。

把更多规则写入 prompt、`CLAUDE.md` 或 skill 会有所帮助，却不能真正强制流程；规则是否被遵守仍取决于智能体自身的行为。

TAKT 将 AI 智能体视为需要从外部控制的对象，而不是仅仅依赖信任。

workflow 定义阶段，每个 step 获得自己的 persona、policy、knowledge、instruction 和 output contract。TAKT 以声明式方式管理实现、审查、修复和再次审查。把职责、知识和限制分开，再只向当前 step 提供所需内容，可以避免上下文膨胀并提高任务质量。

审查不会被静默跳过。发现问题后，工作会回到修复 step；需要时也可以请求人工判断。任务在隔离的 worktree 中运行，每个 step 都留下日志和报告，因此从任务到 PR 的路径可以追溯。

TAKT 将这些环节组织为由角色、阶段、判断和反馈循环组成的可复用智能体流程；开发流程因此不依赖人类持续介入，保持可审查、可复现。

## 5 分钟试用

请在至少有一个 commit 的 Git 仓库中运行：

```bash
npm install -g takt

# 与 AI 对话描述任务，使用 /go，然后选择“加入任务队列”
takt

# 在隔离的 worktree 中执行排队任务
takt run

# 查看 diff、合并、重试、重新排队或删除任务分支
takt list
```

首次运行时，请在 `~/.takt/config.yaml` 中配置 provider，或使用[配置](#配置)中列出的 API key 环境变量。`claude-sdk`、`codex`、`opencode` 和 `pi` 等 SDK provider 可在 Node.js 中运行；`deepseek-harness` 还需要 Python 3.10+ 和官方 runtime wheel。CLI provider 还需要对应的外部 CLI。

### 视频教程

请按照[文字教程](./tutorial.zh-CN.md)完成以下实践操作：

| 第 1 章 | 第 2 章 |
|---------|---------|
| [![观看 TAKT 视频教程第 1 章](https://i.ytimg.com/vi/HUcFFvOy39I/hqdefault.jpg)](https://youtu.be/HUcFFvOy39I) | [![观看 TAKT 视频教程第 2 章](https://i.ytimg.com/vi/UIlM2iM-rmA/hqdefault.jpg)](https://youtu.be/UIlM2iM-rmA) |

## TAKT 与普通 AI 编码智能体的区别

| 普通 AI 编码智能体 | TAKT |
|------------------|------|
| 由 prompt 要求智能体遵守流程 | 由 YAML workflow 管理流程 |
| 审查步骤可能被忘记或跳过 | 审查和修复循环是明确的转移 |
| 一个很长的上下文不断增长 | 每个 step 只获得所需上下文 |
| 实现和审查职责容易混淆 | persona、权限和 output contract 分离职责 |
| 需要靠记忆重新创建同一流程 | workflow 可复用、可审查、可版本化 |

## 要求

TAKT 需要 Node.js `>=22.22.0`。

所选 provider 决定是否需要外部 CLI，或者是否只用 Node.js 即可通过 TypeScript SDK 运行。

以下 provider 通过 SDK 运行，不需要 CLI：

- `claude-sdk` — `@anthropic-ai/claude-agent-sdk`
- `codex` — `@openai/codex-sdk`
- `opencode` — `@opencode-ai/sdk`
- `pi` — `@earendil-works/pi-coding-agent`

`deepseek-harness` 通过私有 JSON-RPC bridge 使用官方 Python SDK。请在 Python 3.10+ 中安装匹配的 SDK/runtime 包：

```bash
python3 -m pip install deepseek-harness-sdk deepseek-harness-runtime-bin
```

官方 runtime 当前支持 Linux x64/arm64 和 macOS arm64。Windows 和 macOS x64 会快速失败；TAKT 不会静默切换到其他 provider。请设置 `DEEPSEEK_API_KEY`，也可以设置 `DEEPSEEK_BASE_URL`。Python SDK 与 `deepseek-harness-runtime-bin` 必须来自匹配的版本。这是 developer-preview 兼容性边界；使用新的 SDK/runtime 组合前，请按照配置指南执行 opt-in live smoke。

以下 provider 需要外部 CLI：

- `claude` — [Claude Code](https://claude.ai/code)
- `claude-terminal` — 在交互式终端会话中驱动 [Claude Code](https://claude.ai/code)，还需要 [`tmux`](https://github.com/tmux/tmux)
- `copilot` — [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli)
- `cursor` — [Cursor Agent](https://docs.cursor.com/)
- `kiro` — [Kiro CLI](https://kiro.dev/docs/cli/headless/)

可选工具：

- [GitHub CLI](https://cli.github.com/)（`gh`）— 用于 `takt #N` GitHub Issue 任务
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)（`glab`）— GitLab Issue/MR 集成（根据 remote URL 自动检测）

> **关于 OAuth：** 是否可以使用 OAuth 取决于 provider 和使用场景。使用 TAKT 前请查看各 provider 的服务条款。

## 快速开始

### 安装

```bash
npm install -g takt
```

使用 Nix flakes：

```bash
nix run github:nrslib/takt
nix profile install github:nrslib/takt
```

Nix 包只安装 TAKT CLI 本身。外部 CLI provider、`git` 以及 `gh`/`glab` 仍需单独安装，并按[要求](#要求)放在 `PATH` 中或另行配置。

### 与 AI 对话并加入任务队列

```text
$ takt

Select workflow:
  ❯ 🎼 default (current)
    📁 🚀 Quick Start/
    📁 🛠️ Development/
    📁 🔍 Review/

> Add user authentication with JWT

[AI clarifies requirements and organizes the task]

> /go

Proposed task:
  ...

What would you like to do?
    Execute now
    Create GitHub Issue
  ❯ Queue as task          # ← 常规流程
    Continue conversation
```

选择 `Queue as task` 会将任务保存到 `.takt/tasks/`。运行 `takt run` 后，TAKT 创建隔离的 worktree，执行 workflow（plan → implement → review → fix 循环），结束后询问是否创建 PR。

```bash
# 执行排队任务
takt run

# 也可以从 GitHub Issue 加入任务
takt add #6
takt add #12

# 执行所有待处理任务
takt run
```

> **选择“Execute now”：** workflow 会直接在当前目录运行，不创建 worktree 隔离。它适合快速实验，但修改会直接进入当前工作树。

### 管理结果

```bash
# 查看任务分支，并进行合并、重试、重新排队、强制失败或删除
takt list
```

## 工作原理

TAKT 的名称来自德语 “Takt”，意为节拍或指挥棒的一击；指挥家用它来让乐团保持同步。TAKT 在面向用户和实现的术语中都统一使用 **workflow** 与 **step**。

workflow 由一系列 step 定义。使用 `steps`、`initial_step` 和 `max_steps`。每个 step 指定 persona（由谁执行）、权限（允许做什么）以及规则（接下来做什么）。最小示例：

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
        next: implement    # ← 修复循环
```

规则决定下一个 step。`COMPLETE` 表示 workflow 成功结束，`ABORT` 表示失败结束。完整 schema、并行 step 和规则条件类型请参阅 [Workflow Guide](./workflows.zh-CN.md)。

可复用的 step 定义可以放在 `.takt/steps/`，再通过 `uses` 展开。片段查找和覆盖规则请参阅 Workflow Guide。

正式的 workflow 目录名是 `workflows/`。同名 workflow 存在于多个位置时，TAKT 按以下顺序解析：`.takt/workflows/` → `~/.takt/workflows/` → builtins。

## 推荐 workflow

| Workflow | 用途 |
|----------|------|
| `default` | 标准开发流程。基于场景的规划与测试优先开发，配合动态实现 companion、多视角并行审查、裁定和收敛式修复循环 |
| `maintenance` | 面向既有代码库的 `default` 变体：保护变更范围外的契约，只做与请求有因果关系的修改 |
| `simple` | 与 `pure` 相同的最小结构，TAKT 按变更内容自动选择并注入领域 facet 的轻量流程；始终包含 AI 反模式与架构指导 |
| `pure` | 不注入领域 facet 的最小流程，信任模型自身的判断与 skill 选择 |
| `takt-default` | TAKT 自身使用的开发流程，也适用于其他 CLI 工具 |
| `takt-default-team` | 通过 Team Leader 任务分解执行实现与修复的 `takt-default` 变体 |
| `review` | 按变更动态选择 reviewer 并由 supervisor 汇总的多视角审查，不修改代码 |
| `review-fix` | 按变更动态选择 reviewer 的多视角审查，随后使用标准 workflow 的裁定、验证修复循环和最终需求检查收敛 |

领域特化系列（`simple-*` / `frontend` / `backend` / `dual` / CQRS / `*-mini` 变体）仍可在 📦 Legacy 分类中使用。

所有 builtin workflow 和 persona 请参阅 [Builtin Catalog](./builtin-catalog.md)。

## 主要命令

| 命令 | 说明 |
|------|------|
| `takt` | 与 AI 对话、完善需求、执行或排队任务 |
| `takt exec` | 启动即时 Assistant/Worker/Review agent 模式，无需写 workflow YAML |
| `takt add` | 通过 AI 对话完善任务并加入队列，也可从 GitHub Issue 创建 |
| `takt run` | 执行所有待处理任务 |
| `takt watch` | 监视任务队列并自动执行待处理任务 |
| `takt list` | 管理任务分支：合并、重试、重新排队、强制失败、指导或删除 |
| `takt #N` | 将 GitHub Issue 作为任务输入 |
| `takt eject` | 复制 builtin workflow/facet 以便定制 |
| `takt workflow init` | 创建 workflow scaffold |
| `takt workflow doctor` | 验证 workflow 定义 |
| `takt workflow inspect` | 检查 workflow 的配置与解析来源 |
| `takt repertoire add` | 从 GitHub 安装 repertoire package |

全部命令和选项请参阅 [CLI Reference](./cli-reference.zh-CN.md)。

TAKT 还提供两个客户端集成入口：`takt-acp` 通过 stdio JSON-RPC 作为 [Agent Client Protocol](./cli-reference.zh-CN.md#acp-agent) agent 运行；`takt-mcp` 作为 stdio [MCP server](./cli-reference.zh-CN.md#mcp-server) 运行，让 MCP 客户端（Codex、Claude Code 等）可以加入任务队列。使用 `takt run` 或 `takt watch` 执行待处理任务。

### 即时 exec 模式

`takt exec` 启动 TAKT 的交互式任务录入模式。Assistant agent 澄清需求，`/go` 将对话转换为生成的 workflow，Worker agent 实现任务，Review agent 审查结果，Replanning agent 在需要时向用户询问方向；循环检测会阻止无效的重复循环。

exec 会从上一次 exec 配置启动；首次使用时使用默认配置。传入 preset 名称可以从指定 preset 开始。在对话中使用 `/setup` 编辑 agent、循环检测阈值、preset 以及引用的 instruction/knowledge/policy facet。builtin/default preset 只定义角色、facet 和循环阈值。exec 启动时从普通 TAKT 配置解析 provider 和 model，并在 Assistant 对话与 `/setup` 显示中使用同一解析结果。生成的 workflow 使用 capability 表达工具/技能需求；provider、model 和 options 留在 runtime 配置中。

exec preset 的解析顺序是：项目 `.takt/exec/presets/` → 全局 `$TAKT_CONFIG_DIR/exec/presets/`（默认 `~/.takt/exec/presets/`）→ builtin `builtins/exec/presets/`。`/setup` 的变更保存到 `$TAKT_CONFIG_DIR/exec.yaml`（默认 `~/.takt/exec.yaml`），供下次 exec 使用。`/go` 会生成 `.takt/exec/workflow.yaml` 并通过普通 workflow engine 执行；没有对话或内联任务文本时，`/go` 不会生成 workflow。使用 `/cancel` 可退出而不运行。

exec 输入支持图片附件。使用 `/paste-image` 或 macOS 上的 `Ctrl+V` 附加剪贴板图片；TAKT 会插入 `[Image #N]` 占位符。只有在 Assistant 消息或 `/go` 备注中引用该占位符时，图片才会随请求发送。支持 PNG、JPEG、GIF 和 WebP，内联及剪贴板图片限制为 10 MiB。

## 配置

最小的 `~/.takt/config.yaml`：

```yaml
provider: claude              # claude, claude-sdk, claude-terminal, codex, opencode, deepseek-harness, cursor, copilot, kiro, pi, or mock
model: sonnet                 # 直接传给 provider
language: en                  # en 或 ja；当前 UI 不提供 zh-CN
```

下面是保留的旧版配置模式示例。runtime 模式下，应将 provider、model、provider options 和路由放入 `runtime.yaml`；workflow YAML 不能设置这些执行配置：

```yaml
provider: codex          # 没有 workflow step 上下文时使用；没有 auto_routing 时也是默认值
model: gpt-5.6-sol
takt_providers:
  assistant:             # 可选覆盖；interactive / instruct / retry 不使用 auto routing
    provider: codex
    model: gpt-5.6-sol
auto_routing:
  strategy: balanced   # cost、balanced 或 performance
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: advanced
      description: Planning, final decisions, requirement-fulfillment judgment, and other advanced reasoning
      provider: codex
      model: gpt-5.6-sol
      routing_tier: high
    - name: coding
      description: Implementation, tests, debugging, and refactoring
      provider: codex
      model: gpt-5.6-terra
      routing_tier: medium
    - name: lightweight
      description: Formatting and small mechanical edits
      provider: codex
      model: gpt-5.6-luna
      routing_tier: low
  rules:
    steps:
      security-audit: advanced
  default_pool: general
  candidate_pools:
    general:
      candidates: [lightweight, coding, advanced]
      fallback: advanced
    implementation:
      candidates: [coding, advanced]
      fallback: advanced
  pool_rules:
    tags:
      implementation: implementation
```

旧版模式中，没有 workflow-step 上下文的操作使用具体的顶层 provider/model；Assistant 对话不走 auto routing。自动路由决策只在本地以 NDJSON 写入 `.takt/events/`，可通过 `telemetry.routing_decisions` 或 `takt telemetry status|enable|disable` 查看和控制，TAKT 不会上传这些决策。

运行元数据、session、trace、report 等运行产物仍以普通文件保存在 `.takt/runs/<run>/` 下。

更完整的配置、provider profile、model 解析和 `runtime.yaml` 说明请参阅[配置指南](./configuration.zh-CN.md)。

TAKT 也可以直接使用 provider 凭据（当对应 SDK/runtime 已安装时不需要 CLI）：

```bash
export TAKT_ANTHROPIC_API_KEY=sk-ant-...   # Anthropic（Claude）
export TAKT_OPENAI_API_KEY=sk-...          # OpenAI（Codex）
export TAKT_OPENCODE_API_KEY=...           # OpenCode
export TAKT_CURSOR_API_KEY=...             # Cursor Agent（可选）
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...   # GitHub Copilot CLI
export TAKT_KIRO_API_KEY=...               # Kiro CLI
export DEEPSEEK_API_KEY=...                 # 官方 DeepSeek Harness SDK
# 可选：export DEEPSEEK_BASE_URL=https://...
# Pi 使用其 SDK credential store 或 provider 原生环境变量
```

OpenCode 默认有 60 分钟的 provider-event 不活跃上限；如果调用可能超过此时间，请显式设置 `provider_options.opencode.guards.call_timeout_ms`（最多 86,400,000 ms）：

```yaml
provider_options:
  opencode:
    guards:
      profile: standard
      model_profiles:
        "opencode/big-pickle": minimal
        "lmstudio/*": standard
      call_timeout_ms: 7200000
      text_byte_limit: 1048576
      reasoning_byte_limit: 4194304
```

已移除的 `TAKT_OPENCODE_TOOL_ERROR_BUDGET`、`TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE`、`TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS`、`TAKT_OPENCODE_TOOL_SUCCESS_REPEATS` 和 `TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS` 会被忽略，并发出一次迁移警告。详见配置指南中的 v6 guard 策略。

### 专用 provider 配置（`runtime.yaml`）

provider、model、provider options、自动路由和内部 agent 分配可以放入专用层：`~/.takt/runtime.yaml` 与 `<project>/.takt/runtime.yaml`，项目层优先。`runtime.yaml` 是配置层默认值；CLI 和环境变量覆盖仍然可用。workflow YAML 不能设置 provider/model/options/routing；已移除的字段会在加载时失败并给出迁移提示。

Companion reviewer 默认禁用。要启用它们，请在 `runtime.yaml` 设置顶层策略：

```yaml
version: 1
companion:
  enabled: true
```

全局和项目策略都设置时按逻辑 AND 合并；全局 `false` 不能由项目设置重新启用。省略的策略在层合并时是 neutral；两层都没有设置时 Companion 仍禁用。Companion target 和 provider capability 只在启用时解析/执行；禁用时仍会进行 companion 声明和 target 结构校验，但不会解析或运行 companion provider。

## 定制

### 自定义 workflow

```bash
takt workflow init my-flow   # 创建 workflow scaffold
takt workflow doctor my-flow # 验证 workflow 定义
takt eject default           # 复制 builtin workflow 到 ~/.takt/workflows/ 并编辑
```

### 自定义 persona

在 `~/.takt/facets/personas/` 中创建 Markdown 文件：

```markdown
# ~/.takt/facets/personas/my-reviewer.md
You are a code reviewer specialized in security.
```

在 workflow 中引用：`persona: my-reviewer`。

`~/.takt/personas/` 仍作为兼容路径有效，但 `takt catalog` 只扫描 `facets/` 目录。详情请参阅 [Workflow Guide](./workflows.zh-CN.md)。

## CI/CD

TAKT 为 GitHub Actions 提供 [takt-action](https://github.com/nrslib/takt-action)：

```yaml
- uses: nrslib/takt-action@main
  with:
    anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

其他 CI 系统可以使用 pipeline 模式：

```bash
takt --pipeline --task "Fix the bug" --auto-pr
```

完整设置请参阅 [CI/CD Guide](./ci-cd.md)。

## 项目结构

```text
~/.takt/                    # 全局配置
├── config.yaml             # provider、model、language 等
├── workflows/              # 用户 workflow 定义
├── facets/                 # 用户 facet（persona、policy、knowledge 等）
└── repertoire/             # 已安装的 repertoire package

.takt/                      # 项目级目录
├── config.yaml             # 项目配置
├── workflows/              # 项目 workflow 覆盖
├── facets/                 # 项目 facet
├── tasks.yaml              # 待处理任务
├── tasks/                  # 任务规格
└── runs/                   # 执行报告、日志和上下文
```

## 采用 Spec-Driven Development

TAKT 以声明式 YAML 状态机强制阶段转移，通过 output contract 固化每个阶段的产物，并通过并行审查和修复循环处理偏差。这种结构适合遵循 Spec-Driven Development（SDD）的用户。社区项目 [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) 提供 Requirements → Gap Analysis → Design → Tasks → Implementation → Validation 工作流，以及 OpenSpec 风格的变更提案流程：

```bash
npx create-takt-sdd
```

其他社区集成请参阅[外部集成](./external-integrations.zh-CN.md)。

## 文档

### 简体中文文档

本次简体中文翻译采用文件名后缀 `.zh-CN.md`。它与既有英文原文件和 `.ja.md` 日语文件并存；`zh-CN` 明确表示简体中文，而不是运行时 UI 语言。

已翻译并维护以下入口：

| 文档 | 说明 |
|------|------|
| [教程](./tutorial.zh-CN.md) | 通过三个阶段改进一个示例，并学习排队、运行和检查任务 |
| [CLI 参考](./cli-reference.zh-CN.md) | 所有命令和选项 |
| [配置](./configuration.zh-CN.md) | 全局与项目设置、provider 和 runtime |
| [Workflow 指南](./workflows.zh-CN.md) | 创建和定制 workflow |
| [任务管理](./task-management.zh-CN.md) | 任务排队、执行和隔离 |
| [外部集成](./external-integrations.zh-CN.md) | 不修改核心的社区集成示例 |
| [中文文档入口](./README.zh-CN.md) | 安装、快速开始和文档导航 |

以下完整文档页面暂不翻译，继续以英文/日文提供：Builtin Catalog、Observability、Design Philosophy、Faceted Prompting、Token Saving、Repertoire Packages、CI/CD、Testing、Contributing、Changelog，以及项目设计和开发内部文档。运行时 UI、prompt 和 `language` 配置也没有新增中文选项；本次变更只增加文档，不修改 runtime 行为。

## 赞助者

TAKT 通过 CodeRabbit 的 Open Source Support Program 获得支持。

<a href="https://coderabbit.link/nrslib">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://victorious-bubble-f69a016683.media.strapiapp.com/White_Typemark_79b9189d19.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://victorious-bubble-f69a016683.media.strapiapp.com/Orange_Typemark_43bf516c9d.svg">
    <img alt="CodeRabbit" src="https://victorious-bubble-f69a016683.media.strapiapp.com/Orange_Typemark_43bf516c9d.svg" height="40">
  </picture>
</a>

## 社区

如有问题、讨论或更新，欢迎加入 [TAKT Discord](https://discord.gg/R2Xz3uYWxD)。

## 贡献

请参阅英文 [CONTRIBUTING.md](../CONTRIBUTING.md) 了解详情。

## 许可证

MIT — 详情请参阅 [LICENSE](../LICENSE)。
