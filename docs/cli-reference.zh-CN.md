# CLI 参考

[English](./cli-reference.md) | [日本語](./cli-reference.ja.md) | [简体中文](./cli-reference.zh-CN.md)

本文是 TAKT CLI 命令和选项的参考。

## 全局选项

| 选项 | 说明 |
|------|------|
| `--pipeline` | 启用 pipeline（非交互）模式；CI/自动化必需 |
| `-t, --task <text>` | 任务内容（GitHub Issue 的替代方式） |
| `-i, --issue <N>` | GitHub Issue 编号（等同于交互模式中的 `#N`） |
| `-w, --workflow <name or path>` | workflow 名称或 workflow YAML 文件路径 |
| `-b, --branch <name>` | 指定分支名（省略时自动生成） |
| `--pr <number>` | 获取审查评论并修复指定 PR |
| `--auto-pr` | 执行后创建 PR（仅 pipeline 模式） |
| `--draft` | 创建 draft PR（需要 `--auto-pr` 或 `auto_pr` 配置） |
| `--skip-git` | 跳过创建分支、commit 和 push（pipeline 模式，仅执行 workflow） |
| `--repo <owner/repo>` | 指定仓库（创建 PR 时使用） |
| `-q, --quiet` | 最小输出模式：抑制 AI 输出（用于 CI） |
| `--provider <name>` | 覆盖 agent provider（claude\|claude-sdk\|claude-terminal\|codex\|opencode\|deepseek-harness\|cursor\|copilot\|kiro\|pi\|mock） |
| `--auto-strategy <strategy>` | 覆盖自动路由策略（`cost`\|`balanced`\|`performance`）。只有执行进入当前 workflow 或具有有效 `auto_routing` 的 workflow-call 子流程时才应用；否则 TAKT 会警告并忽略。 |
| `--model <name>` | 覆盖 agent model |
| `-c, --continue` | 从当前项目目录和 provider 的上一次 assistant session 继续 |
| `--tui` | 终端下这本就是默认形态：stdin 与 stdout 均为 TTY 时，无论是否指定该选项，任务对话都由 Ink 绘制；管道输入则继续使用原有读取器。该选项只是把这一前提写明——没有 TTY 时不会回退，而是以 `--tui requires an interactive terminal` 失败。工作流选择、模式选择和总结后的操作选择仍使用原有选择器，TUI 只负责对话本身。Enter 发送，Shift+Enter / Option+Enter 换行，Ctrl+K 删除到行尾，Esc 中断正在生成的回答，队列中的内容会作为下一轮立即发送。回答期间提交的行会进入队列并在完成后发送（队列开始发送前可用 ↑ 取回编辑）。任务执行后会话继续保持，直到 /cancel |

`--workflow` 是规范选项。

全局配置目录默认为 `~/.takt/`，可通过 `TAKT_CONFIG_DIR` 环境变量修改。

## 交互模式

交互模式会先与 AI 对话来完善任务内容，然后再执行。当需求不明确，或希望在咨询 AI 的同时明确内容时，这种模式很有用。

```bash
# 不带参数启动交互模式
takt

# 指定初始消息（仅短单词）
takt hello
```

**注意：** `--task` 会跳过交互模式并直接执行任务。Issue 引用（`#6`、`--issue`）会作为交互模式的初始输入。

### 流程

1. 选择 workflow
2. 选择交互模式（assistant / grill-me / persona）
3. 通过与 AI 对话完善任务内容
4. 使用 `/go` 完成任务指令（也可以使用 `/go additional instructions` 添加额外指令）
5. 执行 workflow，并按需要创建 PR

### 交互模式变体

| 模式 | 说明 |
|------|------|
| `assistant` | 默认模式。AI 会提出澄清问题，然后生成任务指令。 |
| `grill-me` | 一次处理一个推荐问题，解决重要决策分支；需求准备好后建议使用 `/go`。 |
| `persona` | 与第一个 step 的 persona 对话（使用其 system prompt 和工具）。 |

### 会话设置命令

| 命令 | 效果 |
|------|------|
| `/workflow` | 选择另一个 workflow。 |
| `/interaction` | 选择另一个交互模式。 |
| `/provider` | 选择另一个 provider。 |
| `/model <value>` | 为当前会话指定任意 model 名称。 |
| `/effort <value>` | 为当前会话指定任意推理强度。 |

这些选择只在当前会话中有效，不会持久化。workflow、mode、provider 或 model 的更改会在下一条普通消息或 `/go` 时创建新的 AI session，并只将之前的对话作为参考上下文传递一次。仅更改 effort 时，会应用到当前 session 的下一次调用。更改 provider 会清除临时 model 和 effort。在下一次输入前执行多个设置命令时，每项设置只应用最后一次选择的值。会话 override 不影响 workflow 执行。

### 执行示例

```text
$ takt

Select workflow:
  > default (current)
    Development/
    Research/
    Cancel

交互模式 - 请描述任务。准备好后，使用 /go 创建指令并运行。

> I want to add user authentication feature

[AI confirms and organizes requirements]

> /go

Proposed task instructions:
---
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
---

Proceed with these task instructions? (Y/n) y

[Workflow execution starts...]
```

## 直接执行任务

使用 `--task` 跳过交互模式并直接执行：

```bash
# 使用 --task 指定任务内容
takt --task "Fix bug"

# 指定 workflow
takt --task "Add authentication" --workflow dual
```

**注意：** 直接传入字符串（例如 `takt "Add login feature"`）仍然会进入交互模式，只是将该字符串作为初始消息。

<a id="acp-agent"></a>

## ACP Agent

`takt-acp` 通过 stdio JSON-RPC 以 Agent Client Protocol agent 的形式启动 TAKT。请在支持 ACP 的客户端中将它作为 agent 命令启动：

```bash
takt-acp
```

ACP session 的 `cwd` 必须是绝对路径。TAKT 将该目录同时作为对话基目录和 workflow 项目根目录。默认情况下，`session/prompt` 是“先加入队列”的对话入口：诸如“enqueue this task”或“make it a pending task”的 prompt 会将待处理任务写入 `.takt/tasks.yaml`，之后可以用 `takt run` 执行。只有明确要求“run it now”或“execute now”时才直接执行 workflow；含义不明确的 prompt 会留在对话中。

主 ACP UX 不依赖 `/go`：它遵循 session 的 `defaultAction`，默认加入队列。

如果 ACP prompt 创建或直接执行任务，TAKT 使用 `default` workflow，除非对话结果明确给出其他 workflow。

`session/new` 可以省略 `mcpServers`；省略或使用空数组 `mcpServers: []` 都表示没有 MCP server。stdio MCP server 会传给 workflow 执行，但如果某个 step 的有效 provider 不支持 MCP server，TAKT 会在运行前快速失败。非 stdio MCP transport、重复的 MCP server 名称和重复的去空格 MCP 环境变量名会在创建 session 时被拒绝。

TAKT 当前支持 `initialize`、`session/new`、`session/prompt`、`session/cancel` 和 `session/update` 通知。不公布 `additionalDirectories`；非空的 `additionalDirectories` 请求会被拒绝。

<a id="mcp-server"></a>

## MCP Server

`takt-mcp` 通过 stdio 启动 TAKT 的 Model Context Protocol server。若希望 MCP 客户端无需调用 `takt add` 就能加入 TAKT 任务队列，请在客户端中注册它。

```bash
takt-mcp
```

对于 Codex，可以将 stdio MCP server 添加到 `~/.codex/config.toml`，或添加到可信项目的 `.codex/config.toml`：

```toml
[mcp_servers.takt]
command = "takt-mcp"
```

也可以使用 Codex MCP CLI 添加：

```bash
codex mcp add takt -- takt-mcp
```

server 暴露以下工具：

| 工具 | 说明 |
|------|------|
| `takt_enqueue_task` | 将待处理任务保存到 `.takt/tasks.yaml`，可选关联或创建 Issue。 |

每个工具的 `cwd` 都会通过 `realpath` 解析，且必须位于 MCP server 允许的项目根目录内。默认允许的根目录是启动 `takt-mcp` 的目录。

### `takt_enqueue_task`

必需输入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | 绝对路径字符串 | 写入 `.takt/tasks.yaml` 的项目根目录。 |
| `task` | 字符串 | 任务指令正文。 |
| `workflow` | 字符串 | workflow 名称或路径。MCP 调用方必须在加入队列前询问使用哪个 workflow。 |
| `autoPr` | 布尔值 | 是否以启用 auto-PR 的方式保存任务。MCP 调用方必须在加入队列前询问。 |

可选输入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `worktree` | 布尔值 | `true` 创建自动隔离的 worktree，默认是 `true`。MCP 输入不接受自定义 worktree 路径。 |
| `issue.number` | 正的安全整数 | 关联已有 Issue，不调用 Issue provider。 |
| `issue.create` | `true` | 在加入队列前通过配置的 Issue provider 创建 Issue。 |
| `issue.title` | 字符串 | 新 Issue 的可选非空标题，最多 255 个字符。 |
| `issue.labels` | 字符串数组 | 新 Issue 的可选非空标签。 |
| `taskContext.branch` | 字符串 | 保存到任务中的本地分支名。 |
| `taskContext.baseBranch` | 字符串 | 保存到任务中的基分支名。 |
| `taskContext.prNumber` | 正的安全整数 | 保存到任务中的 PR 编号；大于 `Number.MAX_SAFE_INTEGER` 的值会被拒绝。 |

输入限制：`task` 最多 128 KiB，`workflow` 最多 128 个字符，Issue 标题最多 255 个字符，每个 Issue 标签最多 100 个字符，标签最多 20 个。

`issue` 对象必须严格是 `{ "number": 123 }` 或 `{ "create": true, "title"?: "...", "labels"?: ["..."] }` 之一；混合 key、空标题、空标签和未知 key 都会被拒绝。Issue 关联的加入队列成功后会返回 `issueNumber`。如果创建 Issue 成功，但保存任务失败或在解析 Issue 编号后被取消，Issue 会保持打开状态；MCP 错误结果包含 `issueCreated`、`issueNumber`、可选的 `issueUrl`、`taskEnqueued`、`stage` 和已清理的 `error`。使用 `{ "issue": { "number": issueNumber } }` 重试可避免重复创建 Issue。如果 `stage` 是 `issue_number_parsing`，则无法得到 `issueNumber`；可以使用可选的 `issueUrl` 找到 Issue 并取得编号后再重试。

MCP 只负责加入任务队列。请使用 `takt run` 执行待处理任务，使用 `takt watch` 持续监视并执行任务。

## 即时 Exec 模式

`takt exec` 启动无需手写 workflow YAML 的交互式任务录入模式。Assistant agent 澄清需求，`/go` 将对话转换成生成的 workflow，Worker agent 实现任务，Review agent 审查结果，Replanning agent 在需要时询问用户方向，循环检测防止无效循环。

```bash
takt exec          # 使用上一次配置；首次使用时采用默认配置
takt exec backend  # 从指定名称的 preset 开始
takt exec --list   # 列出可用 exec preset
```

preset 查找顺序为项目 `.takt/exec/presets/`、全局 `$TAKT_CONFIG_DIR/exec/presets/`（未设置时为 `~/.takt/exec/presets/`），最后是 builtin `builtins/exec/presets/`。builtin/default preset 只定义 agent 角色、facet 和循环阈值。exec 启动时从普通 TAKT 配置解析 provider 和 model，Assistant 对话与 `/setup` 显示使用同一解析结果。生成的 workflow 使用 capability 表达工具/skill 需求；provider/model/options 留在 `runtime.yaml`（或旧版 config）中。

exec 模式中的命令：

| 命令 | 说明 |
|------|------|
| `/setup` | 编辑 agent、replan facet、循环检测阈值以及项目/全局 preset |
| `/go` | 将对话总结为可执行任务指令，并运行生成的 workflow |
| `/go <note>` | 运行时将额外备注追加到对话总结 |
| `/paste-image` | 编辑当前输入行时，将剪贴板图片替换为图片占位符 |
| `/cancel` | 不执行任务直接退出 |

`/setup` 可以保存或删除项目/全局 preset。instruction、knowledge 和 policy 字段引用普通 facet；新 facet 保存在 `.takt/facets/{instructions,knowledge,policies}/` 或 `$TAKT_CONFIG_DIR/facets/{instructions,knowledge,policies}/`（未设置时为 `~/.takt/facets/{instructions,knowledge,policies}/`）。

执行 `/go` 时，TAKT 写入 `.takt/exec/workflow.yaml`，并通过现有 workflow engine 执行。没有此前对话且没有内联任务文本时，`/go` 会在创建 workflow 前被拒绝。exec workflow 使用 `session_key` 将 Worker、Review 和 Replanning agent 的 session 分开；loop detection judge 始终使用新 session。

exec 输入支持图片附件。使用 `/paste-image` 或 macOS 上的 `Ctrl+V` 附加图片；TAKT 插入 `[Image #N]` 占位符。只有当前消息或 `/go <note>` 引用了占位符时，图片才会发送给 Assistant。支持 PNG、JPEG、GIF 和 WebP，内联及剪贴板图片限制为 10 MiB。没有原生图片输入的 provider 会在 prompt 中收到本地路径引用。

## GitHub Issue 任务

可以直接将 GitHub Issue 作为任务执行。Issue 的标题、正文、标签和评论会自动加入任务内容。

```bash
# 指定 Issue 编号执行
takt #6
takt --issue 6

# 指定 Issue 和 workflow
takt #6 --workflow dual
```

**要求：** [GitHub CLI](https://cli.github.com/)（`gh`）必须已安装并完成认证。

## 任务管理命令

任务管理使用 `.takt/tasks.yaml` 批量处理任务，并在 `.takt/tasks/{slug}/` 中保存任务目录。完整说明请参阅[任务管理](./task-management.zh-CN.md)。

### `takt add`

通过 AI 对话完善要求，然后将任务加入 `.takt/tasks.yaml`：

```bash
# 通过 AI 对话完善要求，然后加入任务
takt add

# 从 GitHub Issue 添加任务（Issue 编号会反映在分支名中）
takt add #28

# 指定排队任务使用的 workflow
takt add -w default

# 根据 PR 审查评论创建任务
takt add --pr 123
```

`-w, --workflow <name or path>` 设置任务保存的 workflow；`--pr <number>` 根据 PR 审查评论创建任务。

### `takt run`

执行 `.takt/tasks.yaml` 中所有待处理任务：

```bash
takt run

# 忽略 workflow max_steps，直到其他停止条件出现
takt run --ignore-exceed
```

不使用 `--ignore-exceed` 时，达到 workflow `max_steps` 的任务会以 `exceeded` 状态停止，并在 `.takt/tasks.yaml` 中保存重试元数据。使用该选项只忽略迭代限制，不写入 exceeded 重试元数据。

### `takt watch`

监视 `.takt/tasks.yaml`，作为常驻进程自动执行新任务：

```bash
takt watch

# 忽略 workflow max_steps，不将任务标记为 exceeded
takt watch --ignore-exceed
```

它会持续运行直到 Ctrl+C，监视新的 `pending` 任务并逐个执行；启动时会将中断的 `running` 任务标记为 `failed`，退出时显示任务总数、成功数和失败数。

### `takt list`

列出任务分支并执行操作：

```bash
# 交互式查看任务分支
takt list

# CI/脚本使用非交互模式
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

`--action` 接受 `diff`、`sync`、`try`、`merge` 或 `delete`。非交互操作需要 `--branch`，`delete` 还需要 `--yes`。交互模式中的 **Merge from root** 会将根仓库 HEAD 合并到任务分支，并使用 AI 辅助解决冲突。

### 任务目录工作流（创建 / 运行 / 验证）

1. 运行 `takt add`，确认 `.takt/tasks.yaml` 中出现待处理记录。
2. 打开生成的 `.takt/tasks/{slug}/order.md`，按需补充详细规格和引用。
3. 运行 `takt run` 或 `takt watch`，执行 `tasks.yaml` 中的待处理任务。
4. 在 `.takt/runs/{run}/reports/` 中检查输出；实际 run slug 以 `tasks.yaml` 的 `run_slug` 为准。

## Pipeline 模式

指定 `--pipeline` 会启用非交互 pipeline 模式：自动创建分支、执行 workflow、commit 并 push，适合 CI/CD 自动化。

```bash
# pipeline 模式执行任务
takt --pipeline --task "Fix bug"

# 执行并自动创建 PR
takt --pipeline --task "Fix bug" --auto-pr

# 关联 Issue
takt --pipeline --issue 99 --auto-pr

# 指定 workflow 和分支
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# 指定创建 PR 的仓库
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# 只执行 workflow，跳过创建分支、commit 和 push
takt --pipeline --task "Fix bug" --skip-git

# CI 最小输出
takt --pipeline --task "Fix bug" --quiet
```

pipeline 模式不会自动创建 PR，除非指定 `--auto-pr`。在 GitHub Actions 中使用 TAKT 时，请参阅 [takt-action](https://github.com/nrslib/takt-action)。

## 工具命令

### 交互式选择 workflow

不带任务参数运行 `takt` 可交互选择 workflow：

```bash
takt
```

### `takt eject`

将 builtin workflow/persona 复制到本地以便定制：

```bash
# 复制到项目 .takt/ 以定制
takt eject

# 复制到 ~/.takt/（全局）
takt eject --global

# 复制指定 facet
takt eject persona coder
takt eject instruction plan --global
```

`eject` 的 facet 类型使用单数：`persona`、`policy`、`knowledge`、`instruction`、`output-contract`；`takt catalog` 使用复数形式。

### `takt workflow`

初始化和验证自定义 workflow：

```bash
# 在项目 .takt/workflows/ 创建最小 scaffold
takt workflow init sample-flow

# 在 ~/.takt/ 创建 faceted scaffold
takt workflow init review-flow --template faceted --global

# 按名称或路径验证 workflow
takt workflow doctor sample-flow
takt workflow doctor .takt/workflows/sample-flow.yaml

# 检查 workflow 的配置与解析来源
takt workflow inspect sample-flow
takt workflow inspect .takt/workflows/sample-flow.yaml
```

`takt workflow inspect` 按运行时相同的解析（包括 `--auto-strategy`）报告 workflow 的配置以及每个解析值的来源。

### `takt clear`

清除 agent 对话 session（重置状态）：

```bash
takt clear
```

### `takt export-cc`

将 builtin workflow/persona 部署为 Claude Code Skill：

```bash
takt export-cc
```

### `takt export-codex`

将 TAKT skill 文件部署为 Codex Skill（`~/.agents/skills/takt/`）：

```bash
takt export-codex
```

该命令部署 `SKILL.md`、`references/`、`agents/`、`workflows/` 和 `facets/`。

### `takt catalog`

列出各层可用 facet：

```bash
takt catalog
takt catalog personas
```

`catalog` 的 facet 类型参数使用复数：`personas`、`policies`、`knowledge`、`instructions`、`output-contracts`；`takt eject` 使用单数形式。

### `takt prompt`

预览每个 step 和阶段组装后的 prompt：

```bash
takt prompt
takt prompt default
```

### `takt reset`

重置设置：

```bash
# 重置全局配置为 builtin 模板（会备份原文件）
takt reset config

# 重置 workflow 分类为 builtin 默认值
takt reset categories
```

### `takt metrics`

显示分析指标：

```bash
# 显示审查质量指标（默认最近 30 天）
takt metrics review

# 指定时间范围
takt metrics review --since 7d
```

### `takt repertoire`

管理来自 GitHub 的外部 TAKT repertoire package：

```bash
# 从 GitHub 安装 package
takt repertoire add github:{owner}/{repo}@{ref}

# 从默认分支安装
takt repertoire add github:{owner}/{repo}

# 列出已安装 package
takt repertoire list

# 删除 package
takt repertoire remove @{owner}/{repo}
```

已安装的 package 保存在 `~/.takt/repertoire/`，其 workflow/facet 会出现在 workflow 选择和 facet 解析中。同名 workflow 的解析顺序为 `.takt/workflows/` → `~/.takt/workflows/` → builtins；repertoire workflow 通过 `@{owner}/{repo}/{workflow-name}` 显式引用。

### `takt telemetry`

管理有效 `auto_routing` 下使用的本地路由事件记录。决策以 NDJSON 写入 `.takt/events/`，TAKT 不会上传这些记录。

```bash
# 查看本地路由记录状态
takt telemetry status

# 启用本地路由记录
takt telemetry enable

# 禁用本地路由记录
takt telemetry disable
```

### `takt resume`

为当前项目目录中最近一次中止或失败的直接（one-shot）运行显示交互菜单（Requeue / Retry / Instruct / View reports / Cancel）。worktree/clone 运行不符合条件；恢复执行会将报告写入新的 run 目录。

```bash
takt resume
```

### `takt purge`

清理旧的分析事件文件：

```bash
# 清理超过 30 天的文件（默认）
takt purge

# 指定保留天数
takt purge --retention-days 14
```
