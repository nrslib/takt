[English](./tutorial.md) | [日本語](./tutorial.ja.md) | [简体中文](./tutorial.zh-CN.md)

# 教程

本教程通过分三个阶段改进一个小项目，带你走完 TAKT 的基本流程。

示例项目是一个**迷你支出备忘录 UI**。第一阶段先构建一个小型前端，第二阶段增加实用功能，第三阶段打磨布局和交互细节。`default` workflow 是标准 workflow，包含较多审查和测试步骤，可能比较重，因此本教程先使用 `frontend-mini`。

> **视频教程：** 可以通过以下实践视频按照同样的教程操作：
> [Chapter 1](https://youtu.be/HUcFFvOy39I) 和
> [Chapter 2](https://youtu.be/UIlM2iM-rmA)。

## 示例项目

你将构建一个在浏览器中运行的小型支出备忘录。

1. **阶段 1：** 构建能够输入金额、类别和备注的最小 UI
2. **阶段 2：** 增加总金额、类别筛选、删除和持久化
3. **阶段 3：** 打磨移动端布局、空状态、焦点状态和视觉设计

不要一次让 TAKT 完成全部内容，而是每次将一个阶段加入队列，检查结果，再提出下一项改进。

## 1. 不使用 GitHub 开始

首先将目标项目变成 Git 仓库。如果你已经在现有仓库中，可以跳过此步骤。

```bash
git init
git add .
git commit -m "initial commit"
```

TAKT 在执行期间会使用分支和任务工作区，因此从至少有一个 commit 的仓库开始更安全。

如果还没有安装 TAKT，请使用 `npm install -g takt` 安装，并准备好 provider CLI（例如 Claude Code）或 API key。

启动 TAKT：

```bash
takt
```

首次启动时，TAKT 会先询问默认 agent 和 workflow 使用的语言，再询问 provider，然后才显示 workflow 选择。

选择 `frontend-mini` workflow。初始界面只列出分类；具体顺序可能因环境而异，但 `frontend-mini` 位于 `Legacy` 分类的 `Frontend` 子分类下。

```text
Select workflow:
    📁 🚀 Quick Start/
    📁 🛠️ Development/
    📁 🔍 Review/
    📁 🏗️ Infrastructure/
    📁 🎵 TAKT Development/
  ❯ 📁 📦 Legacy/
```

在 workflow 上按 `b` 可以收藏；收藏的 workflow 会以 `🎼 {name} [*]` 显示在此界面顶部。

打开分类并选择 `frontend-mini`：

```text
Select workflow in 📦 Legacy:
    📁 ✨ Simple/
    📁 ⚡ Mini/
  ❯ 📁 🎨 Frontend/
    📁 ⚙️ Backend/
    📁 🔧 Dual/
    📁 🔍 Review/
    🎼 cli
```

```text
Select workflow in 🎨 Frontend:
    🎼 simple-frontend
    🎼 frontend
  ❯ 🎼 frontend-mini
    🎼 frontend-maintenance
```

随后 TAKT 会询问交互模式。第一次请选择 **Assistant**。

```text
Select interactive mode:
  ❯ Assistant
    Grill Me
    Persona
```

## 2. 阶段 1：构建最小 UI

向 TAKT 描述第一项任务：

```text
> I want to build a mini expense memo UI that runs in the browser.
> For the first phase, it only needs fields for amount, category, and note, plus a list of added entries.
> Keep it simple with index.html, CSS, and JavaScript.
```

TAKT 可能会提出澄清问题或整理任务。当范围明确后，使用 `/go` 生成任务指令。

```text
> /go This is phase 1, so do not add persistence or summaries yet. Keep it to the smallest usable UI.
```

生成任务指令后，TAKT 会显示操作菜单。选择 **Save as Task**：

```text
What would you like to do?
    Execute now
  ❯ Save as Task
    Continue editing
    Create Issue
```

`Save as Task` 会将生成的指令追加到 `.takt/tasks.yaml`。`Execute now` 会立即执行任务，并询问 `Create worktree?`（默认 Yes），因此默认也会在隔离 worktree 中运行。教程的常规流程是先排队，再使用 `takt run` 执行。

选择 **Save as Task** 后，TAKT 会询问 worktree 设置。`Auto-create PR?` 默认是 Yes；如果不使用 GitHub，请回答 `n`。

运行排队的任务：

```bash
takt run
```

执行结束后检查结果：

```bash
takt list
```

选择已完成的任务。TAKT 会显示该任务的操作。先选择 **View diff**，如果结果值得在本地尝试，再选择 **Try merge**。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
  ❯ View diff
    Instruct
    Merge from root
    Pull from remote
    Try merge
    Merge & cleanup
    Delete
```

`Try merge` 会在不创建 commit 的情况下将任务分支的修改带入工作树。你可以在本地检查 UI 和 diff，满意后再手动 commit。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
    View diff
    Instruct
    Merge from root
    Pull from remote
  ❯ Try merge
    Merge & cleanup
    Delete
```

## 3. 阶段 2：增加实用功能

检查阶段 1 的结果后，排队下一项改进。可以从 `takt` 开始新任务，也可以在 `takt list` 中对已完成任务使用 **Instruct**。

如果要在之前的结果上继续，请运行 `takt list`，选择已完成任务，再选择 **Instruct**：

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
    View diff
  ❯ Instruct
    Merge from root
    Pull from remote
    Try merge
    Merge & cleanup
    Delete
```

Instruct 模式会将之前的 diff 和执行报告作为上下文，让你讨论下一项变更。

```text
> For phase 2, add total amount, category filtering, and row deletion.
> Save entries to LocalStorage so they are restored after reload.
```

准备好指令后使用 `/go`：

```text
> /go Add these features to the existing structure instead of rebuilding the UI from scratch.
```

再次选择 **Save as Task**：

```text
What would you like to do?
  ❯ Save as Task
    Continue editing
```

运行并检查结果：

```bash
takt run
takt list
```

此时继续使用相同循环：需要在本地检查时选择 **View diff**、**Try merge**；结果需要再次修改时选择 **Instruct**。

## 4. 阶段 3：打磨体验

最后打磨 UI 和交互细节。这很适合使用 **Instruct**，因为 TAKT 可以将当前结果作为上下文。

```text
> For phase 3, make the UI work well on narrow mobile widths.
> Add a useful empty state, visible focus styles, and clearer category styling.
> Keep it as a practical everyday tool, not a marketing landing page.
```

使用 `/go` 完成指令：

```text
> /go
```

选择 **Save as Task**：

```text
What would you like to do?
  ❯ Save as Task
    Continue editing
```

运行任务：

```bash
takt run
```

使用 `takt list` 检查结果。满意后选择 **Merge & cleanup**；如果想先在工作树中检查变更，选择 **Try merge**。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
    View diff
    Instruct
    Merge from root
    Pull from remote
    Try merge
  ❯ Merge & cleanup
    Delete
```

基本循环如下：

```text
takt
  -> choose frontend-mini
  -> talk with assistant
  -> /go
  -> Save as Task
takt run
takt list
  -> View diff
  -> Try merge or Merge & cleanup
  -> use Instruct when you want to queue the next phase
```

## 5. 创建 GitHub Issue，再将其加入队列

在 GitHub 仓库中工作时，可以让 TAKT 根据对话创建 GitHub Issue，然后将该 Issue 加入任务队列。

请确认 GitHub CLI 已认证：

```bash
gh auth status
```

启动 TAKT 并选择 `frontend-mini`：

```bash
takt
```

与 TAKT 讨论 Issue 内容：

```text
> For phase 2 of the mini expense memo UI, I want to add total amount, category filtering, deletion, and LocalStorage persistence.
> Please organize this into a GitHub Issue with acceptance criteria.
```

内容准备好后使用 `/go`：

```text
> /go
```

检查生成的任务指令并选择 **Create Issue**：

```text
What would you like to do?
    Execute now
    Save as Task
    Continue editing
  ❯ Create Issue
```

`Create Issue` 会在一个流程中创建 Issue 并保存任务：Issue 创建后会直接进入 worktree 设置提问，不会返回操作菜单。如果已经知道 Issue 编号，也可以使用 `takt add`：

```bash
takt add #1
```

然后继续本地流程：

```bash
takt run
takt list
```

使用 GitHub Issue 可以将需求、讨论和实现任务关联起来，这对团队开发尤其有用。

## 6. 用 Codex 创建 Issue，再交给 TAKT

如果你在 TAKT 之外与 Codex 或其他开发助手交流并创建了 GitHub Issue，仍然可以将 Issue 编号交给 TAKT。

假设 Codex 创建了 Issue `#1`：

```bash
takt add #1
```

`takt add #1` 会获取 GitHub Issue 的标题、正文和评论，并将其保存为待处理的 TAKT 任务。

运行任务：

```bash
takt run
```

检查结果：

```bash
takt list
```

这样可以让日常使用的 AI 或 GitHub 讨论负责创建 Issue，而让 TAKT 负责实现、审查和修复循环。

## 下一步

- [任务管理](./task-management.zh-CN.md)：`takt add`、`takt run` 和 `takt list` 的详细说明
- [CLI 参考](./cli-reference.zh-CN.md)：所有命令和选项
- [配置指南](./configuration.zh-CN.md)：provider、model、workflow 和其他设置
