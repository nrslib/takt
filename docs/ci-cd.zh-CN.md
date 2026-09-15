[English](./ci-cd.md) | [日本語](./ci-cd.ja.md)

# CI/CD 集成

TAKT 可以集成到 CI/CD 流水线中，自动执行任务、审查 PR 和生成代码。本指南介绍 GitHub Actions 的设置、pipeline 模式选项，以及其他 CI 系统的配置。

## GitHub Actions

TAKT 提供官方 [takt-action](https://github.com/nrslib/takt-action)，用于集成 GitHub Actions。

### 完整工作流示例

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

### 权限

`takt-action` 正常运行需要以下权限：

| 权限 | 用途 |
|------|------|
| `contents: write` | 创建分支、提交和推送代码 |
| `issues: write` | 读取 Issue 并发表评论 |
| `pull-requests: write` | 创建和更新 PR |

## Pipeline 模式

指定 `--pipeline` 可启用非交互式 pipeline 模式。该模式会自动创建分支、执行 workflow、提交并推送，适用于无人交互的 CI/CD 自动化环境。

Pipeline 模式必须指定任务来源：`--task`、`--issue` 或 `--pr` 中的一个。如果均未指定，TAKT 将以退出码 `2` 退出。

在 pipeline 模式下，只有显式指定 `--auto-pr` 才会创建 PR。如果同时使用 `--auto-pr` 和 `--skip-git`，则不会创建 PR：TAKT 会输出警告，并根据 workflow 的执行结果退出（只有 workflow 本身成功时退出码才为 `0`）。

### 所有 Pipeline 选项

| 选项 | 说明 |
|------|------|
| `--pipeline` | **启用 pipeline（非交互）模式**——CI/自动化必需 |
| `-t, --task <text>` | 任务内容（GitHub Issue 的替代方式） |
| `-i, --issue <N>` | GitHub Issue 编号（等同于交互模式中的 `#N`） |
| `--pr <number>` | 获取审查评论并修复指定 PR |
| `-w, --workflow <name or path>` | workflow 名称或 workflow YAML 文件路径 |
| `-b, --branch <name>` | 指定分支名（省略时自动生成） |
| `--auto-pr` | 创建 PR（交互模式：跳过确认；pipeline 模式：启用 PR 创建） |
| `--draft` | 创建 draft PR（需要 `--auto-pr` 或 `auto_pr` 配置） |
| `--skip-git` | 跳过创建分支、提交和推送（pipeline 模式，仅执行 workflow） |
| `--repo <owner/repo>` | 指定仓库（创建 PR 时使用） |
| `-q, --quiet` | 最小输出模式：抑制 AI 输出（用于 CI） |
| `--provider <name>` | 覆盖 agent provider（claude\|claude-sdk\|claude-terminal\|codex\|opencode\|deepseek-harness\|cursor\|copilot\|kiro\|pi\|mock） |
| `--model <name>` | 覆盖 agent model |
| `--auto-strategy <strategy>` | 自动路由策略（cost\|balanced\|performance） |

### 命令示例

**基本 pipeline 执行：**

```bash
takt --pipeline --task "Fix bug"
```

**执行 pipeline 并自动创建 PR：**

```bash
takt --pipeline --task "Fix bug" --auto-pr
```

**关联 GitHub Issue 并创建 PR：**

```bash
takt --pipeline --issue 99 --auto-pr
```

**指定 workflow 和分支名：**

```bash
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug
```

**指定用于创建 PR 的仓库：**

```bash
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

**仅执行 workflow（跳过创建分支、提交和推送）：**

```bash
takt --pipeline --task "Fix bug" --skip-git
```

使用 `--skip-git` 时不会推送任何内容，因此 `--auto-pr` 会被忽略，并输出警告。忽略 `--auto-pr` 不会改变执行结果：workflow 失败时仍以退出码 `3` 退出。

**最小输出模式（在 CI 日志中抑制 AI 输出）：**

```bash
takt --pipeline --task "Fix bug" --quiet
```

## 退出码

Pipeline 模式返回细分的退出码，方便 CI 脚本区分失败类型：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 一般错误 |
| `2` | 获取 Issue/PR 失败，或未指定 `--issue`、`--pr`、`--task` 中的任何一个 |
| `3` | workflow 执行失败 |
| `4` | Git 操作失败（环境准备、提交或推送） |
| `5` | PR 创建失败 |
| `130` | 被 SIGINT（Ctrl+C）中断 |

## Pipeline 模板变量

`~/.takt/config.yaml` 中的 pipeline 配置支持模板变量，可自定义提交信息和 PR 正文：

```yaml
pipeline:
  default_branch_prefix: "takt/"
  commit_message_template: "feat: {title} (#{issue})"
  pr_body_template: |
    ## Summary
    {issue_body}
    Closes #{issue}
```

| 变量 | 可用位置 | 说明 |
|------|----------|------|
| `{title}` | 提交信息、PR 正文 | Issue 标题 |
| `{issue}` | 提交信息、PR 正文 | Issue 编号 |
| `{issue_body}` | PR 正文 | Issue 正文 |
| `{report}` | PR 正文 | 固定字符串：``Workflow `{workflow}` completed successfully.`` |

`commit_message_template` 仅在关联 Issue 时生效。仅使用 `--task` 时，提交信息为 `takt: {task}`。

## 其他 CI 系统

对于 GitHub Actions 以外的 CI 系统，全局安装 TAKT 后直接使用 pipeline 模式：

```bash
# 安装 takt
npm install -g takt

# 以 pipeline 模式运行
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

此方式适用于任何支持 Node.js 的 CI 系统，包括 GitLab CI、CircleCI、Jenkins 和 Azure DevOps 等。

## 环境变量

在 CI 环境中进行身份验证时，请按需设置相应的 API 密钥环境变量。除必须使用 provider 官方原生命名的情况外，这些变量使用 TAKT 专用前缀，以避免与其他工具冲突。官方 DeepSeek Harness SDK 使用 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_BASE_URL`。

```bash
# Claude（Anthropic）
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode
export TAKT_OPENCODE_API_KEY=...

# Pi
# 使用 Pi SDK 凭据存储或 provider 原生环境变量

# 官方 DeepSeek Harness SDK 托管环境（uv 管理的 CPython 3.12）
export DEEPSEEK_API_KEY=...
# 可选：export DEEPSEEK_BASE_URL=https://...

# Cursor Agent（已有 cursor-agent 登录会话时可省略）
export TAKT_CURSOR_API_KEY=...

# GitHub Copilot CLI
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...

# Kiro CLI
export TAKT_KIRO_API_KEY=...
```

优先级：环境变量优先于 `config.yaml` 中的设置。

> **注意**：如果已为 SDK provider（Claude SDK、Codex、OpenCode 或 Pi）设置凭据，则无需安装其 CLI，TAKT 会直接调用相应 API。`deepseek-harness` 还需要通过 `takt deepseek-harness install` 创建 uv 托管环境。固定版本的 runtime wheel 会在该安装过程中由 uv 从软件包索引下载，并不随 TAKT 捆绑分发。该 wheel 支持 glibc >= 2.28 的 Linux x64/arm64，以及 macOS arm64 >= 14.0。不支持 Linux musl、较旧的 Linux glibc、较旧的 macOS 版本、Windows 和 macOS x64；无需安装系统 Python。Cursor、Copilot 和 Kiro 需要安装各自的 CLI。

## 成本注意事项

TAKT 使用 AI API（Anthropic、OpenAI 等），可能产生较高费用，尤其是在 CI/CD 环境中自动执行任务时。建议采取以下措施：

- **监控 API 用量**：在 AI provider 侧设置账单提醒，避免意外费用。
- **使用 `--quiet` 模式**：减少输出量，但不会减少 API 调用次数。
- **选择合适的 workflow**：简单 workflow 的 API 调用次数少于多阶段 workflow（例如包含并行审查的 `default`）。
- **限制 CI 触发条件**：使用条件触发（如 `if: contains(github.event.comment.body, '@takt')`），防止意外执行。
- **使用 `--provider mock` 测试**：开发 CI 流水线时使用 mock provider，避免产生实际 API 费用。
