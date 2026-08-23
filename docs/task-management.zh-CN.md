# 任务管理

[English](./task-management.md) | [日本語](./task-management.ja.md) | [简体中文](./task-management.zh-CN.md)

## 概览

TAKT 提供了用于积累多个任务并批量执行的任务管理流程：

1. **`takt add`** — 通过 AI 对话完善任务要求，并保存到 `.takt/tasks.yaml`
2. **积累任务** — 编辑 `order.md` 文件，附加参考材料
3. **`takt run`** — 一次执行所有待处理任务（顺序或并行）
4. **`takt list`** — 查看结果、合并分支、重试失败任务或追加指令

每个任务可在隔离 clone 中执行，生成报告，并创建可以通过 `takt list` 合并或丢弃的分支。

## 添加任务（`takt add`）

使用 `takt add` 在 `.takt/tasks.yaml` 创建新任务条目：

```bash
# 使用内联文本添加任务
takt add "Implement user authentication"

# 从 GitHub Issue 添加任务
takt add #28
```

添加任务时会询问：

- **Workflow** — 执行时使用哪个 workflow
- **Base branch** — 当前分支不是 `main`/`master` 时，是否使用当前分支作为基分支
- **Worktree path** — 创建隔离 clone 的位置（回车自动选择，也可以指定路径）
- **Branch name** — 自定义分支名（回车自动生成 `takt/{timestamp}-{slug}`）
- **Auto-PR** — 成功执行后是否自动创建 pull request（默认 Yes）
- **Draft PR** — 启用 Auto-PR 时，是否将 PR 创建为 draft（`Create as draft?`）

### GitHub Issue 集成

传入 Issue 引用（例如 `#28`）时，TAKT 通过 GitHub CLI（`gh`）获取 Issue 标题、正文、标签和评论，并将其作为任务内容。Issue 编号会记录到 `tasks.yaml`，也会反映在分支名中。

**要求：** [GitHub CLI](https://cli.github.com/)（`gh`）必须已安装并完成认证。

### 从交互模式保存任务

也可以从交互模式保存任务。对话完善需求后，使用 `/save`（或提示出现时的 save action），将任务持久化到 `tasks.yaml`，而不是立即执行。

### 从 MCP 客户端保存任务

MCP 客户端可以使用 `takt-mcp` stdio server 保存待处理任务，无需调用 shell 命令。`takt_enqueue_task` 将待处理记录写入 `.takt/tasks.yaml`；可选的 `issue` 对象可以关联已有 Issue，或通过已配置的 TAKT Issue provider 创建 Issue。如果创建 Issue 后保存任务失败且已解析到 Issue 编号，Issue 会保持打开，MCP 错误结果会返回编号以便重试；如果无法解析编号，结果可能提供 Issue URL。工具要求绝对路径 `cwd` 和非空任务正文。使用 `takt run` 执行，使用 `takt watch` 监视和持续执行。输入字段详见 [CLI 参考](./cli-reference.zh-CN.md#mcp-server)。

## 任务目录格式

TAKT 将任务元数据存储在 `.takt/tasks.yaml`，并将每个任务的详细规格存储在 `.takt/tasks/{slug}/`。

### `tasks.yaml` Schema

```yaml
tasks:
  - name: add-auth-feature
    status: pending
    task_dir: .takt/tasks/20260201-015714-implement-user-authentication
    workflow: default
    created_at: "2026-02-01T01:57:14.000Z"
    started_at: null
    completed_at: null
```

字段：

| 字段 | 说明 |
|------|------|
| `name` | AI 生成的任务 slug |
| `status` | `pending`、`running`、`completed`、`failed`、`exceeded` 或 `pr_failed`（workflow 成功但 PR 创建/push 失败） |
| `task_dir` | 包含 `order.md` 的任务目录路径 |
| `workflow` | 执行时使用的 workflow 名称 |
| `worktree` | `true`（自动）、路径字符串，或省略（在当前目录运行） |
| `branch` | 分支名（省略时自动生成） |
| `base_branch` | clone 和 PR 的基分支 |
| `auto_pr` | 执行后是否自动创建 PR |
| `draft_pr` | 自动创建的 PR 是否为 draft |
| `issue` | 配置的 Issue provider 返回的 Issue 编号（如适用） |
| `run_slug` | 最新 run 目录的 slug |
| `failure` | 失败详情（`step`、`error`、`last_message`） |
| `created_at` | ISO 8601 创建时间 |
| `started_at` | ISO 8601 开始执行时间 |
| `completed_at` | ISO 8601 完成执行时间 |

`tasks.yaml` 还可能包含由 TAKT 内部管理的字段，如 `slug`、`source_run_slug`、`resume_mode`、`owner_pid`、`auto_requeue_count`、`exceeded_*` 等。

### 任务目录布局

```text
.takt/
  tasks/
    20260201-015714-implement-user-authentication/
      order.md          # 自动生成、可编辑的任务规格
      schema.sql        # 可选的参考材料
      wireframe.png     # 可选的参考材料
  tasks.yaml            # 任务元数据记录
  runs/
    20260201-020152-implement-user-authentication-x7k2pq/
      reports/           # 自动生成的执行报告
      logs/              # NDJSON session 日志
      context/           # snapshot（previous_responses 等）
      operations/        # 操作 journal（journal.json）
      meta.json          # run 元数据
```

每次执行都会为 run 目录单独生成 slug，并追加随机的 6 字符后缀，因此它与任务目录 slug 不同。可查看 `tasks.yaml` 中的 `run_slug` 或 `.takt/runs/` 下最新目录来定位 run。

`takt add` 会自动创建 `.takt/tasks/{slug}/order.md`，并将 `task_dir` 引用保存到 `tasks.yaml`。执行前可以自由编辑 `order.md`，也可以向任务目录加入 SQL schema、wireframe 或 API spec 等补充文件。

## 执行任务（`takt run`）

执行 `.takt/tasks.yaml` 中所有待处理任务：

```bash
takt run

# 忽略 workflow max_steps，直到其他停止条件出现
takt run --ignore-exceed
```

`run` 命令会认领 pending 任务，并按配置的 workflow 执行。每个任务依次经历：

1. 创建 clone（设置了 `worktree` 时）
2. 在 clone/项目目录执行 workflow
3. worktree 执行时自动 commit 和 push
4. post-execution 流程（设置 `auto_pr` 时创建 PR）
5. 将 `tasks.yaml` 状态更新为 `completed`、`failed` 或 `exceeded`

不使用 `--ignore-exceed` 时，达到 workflow `max_steps` 的任务会变为 `exceeded`，并保存 `exceeded_max_steps`、`exceeded_current_iteration` 和 `resume_point` 等重试元数据。该选项只忽略迭代限制，不写入 exceeded retry metadata。

MCP 客户端只负责加入队列；请使用 `takt run` 或 `takt watch` 执行任务。

### 并行执行（Concurrency）

默认顺序执行（`concurrency: 1`）。在 `~/.takt/config.yaml` 中配置：

```yaml
concurrency: 3              # 同时运行最多 3 个任务（1-10）
task_poll_interval_ms: 500   # 新任务轮询间隔（100-5000ms）
```

当 concurrency 大于 1 时，TAKT 使用 worker pool：最多同时运行 N 个任务，在配置的间隔轮询新任务，worker 空闲后领取新任务，并为每个任务显示带颜色前缀的输出。Ctrl+C 会优雅关闭并等待正在执行的任务完成。

### 中断任务清理

如果 `takt run` 被中断（例如进程崩溃或 Ctrl+C），下一次运行 `takt run` 或 `takt watch` 时，仍为 `running` 的任务会自动标记为 `failed`。之后可显式 requeue 再次运行。

### 自动 Requeue

配置 `auto_requeue_max_attempts` 后，`takt run` 启动时会自动 requeue 失败的 workflow task，直到达到次数上限。默认值为 `0`（只手动 requeue）。详见[配置指南](./configuration.zh-CN.md)。

## 监视任务（`takt watch`）

运行常驻进程，监视 `.takt/tasks.yaml` 并自动执行出现的任务：

```bash
takt watch

# 忽略 workflow max_steps，直到其他停止条件出现
takt watch --ignore-exceed
```

watch 命令会：

- 一直运行到 Ctrl+C（SIGINT）
- 监视新的 `pending` 任务
- 任务出现后立即执行
- 启动时将中断的 `running` 任务标记为 `failed`
- 退出时显示任务总数、成功数和失败数

适合生产者-消费者流程：一个终端用 `takt add` 添加任务，另一个终端用 `takt watch` 自动执行。

## 管理任务分支（`takt list`）

交互式列出并管理任务分支：

```bash
takt list
```

列表按状态（pending、running、completed、failed、exceeded、pr_failed）组织任务，并显示创建日期和摘要。选择任务后会根据状态显示可用操作；列表底部还有一次删除所有任务的 **All Delete**。

### 已完成任务的操作

| 操作 | 说明 |
|------|------|
| **View diff** | 在 pager 中查看相对默认分支的完整 diff |
| **Instruct** | 打开 AI 对话编写追加指令，然后重新执行 |
| **Create PR** | 提交并 push，从任务分支创建 pull request |
| **Merge from root** | 将根分支 HEAD 合并到任务分支，使用 AI 辅助解决冲突 |
| **Pull from remote** | 从 remote origin 拉取最新修改（仅 fast-forward） |
| **Try merge** | squash merge（只 stage，不 commit，便于人工检查） |
| **Merge & cleanup** | squash merge 并删除分支 |
| **Delete** | 丢弃全部修改并删除分支 |

### 失败任务的操作

| 操作 | 说明 |
|------|------|
| **Requeue** | 选择 resume 或 restart 位置，将任务重新置为 `pending`，不打开对话 |
| **Retry** | 打开带失败上下文的 retry 对话，然后重新执行 |
| **Instruct** | 针对该 run 的工作树打开 AI 对话编写追加指令，然后 requeue |
| **Create PR** | 将失败 run 的修改提交并 push，创建 pull request |
| **Delete** | 删除失败任务记录 |

### Pending 任务的操作

| 操作 | 说明 |
|------|------|
| **Delete** | 从 `tasks.yaml` 删除待处理任务 |

### Running 任务的操作

| 操作 | 说明 |
|------|------|
| **Mark as failed** | 将卡住的 `running` 任务标记为 `failed` |

### Exceeded 任务的操作

| 操作 | 说明 |
|------|------|
| **Requeue** | 返回 `pending`，从停止处继续 |
| **Delete** | 永久删除任务 |

### PR-Failed 任务的操作

`pr_failed` 表示 workflow 成功但 PR 创建或 push 失败。这类任务显示 PR 错误信息，并提供与已完成任务相同的操作（**Create PR** 除外）。

### Instruct 模式

对已完成任务选择 **Instruct** 时，TAKT 会打开 AI 对话循环，并预加载：

- 分支上下文（相对默认分支的 diff stat、commit history）
- 上一次 run 的 session 数据（step 日志、report）
- workflow 结构和 step 预览
- 之前的 order 内容

讨论需要的追加修改，准备好后使用 `/go`，再选择：

- **Save as Task** — 使用新指令将任务重新置为 `pending`，稍后执行
- **Continue editing** — 继续在对话中完善指令

要立即重新执行，可使用 `/accept`（使用最新 assistant response）或 `/replay`（重新提交上一次 order）；使用 `/cancel` 放弃并返回列表。

失败任务的 **Instruct** 使用相同的对话，但目标是该 run 未提交的工作树，而不是已提交的分支。对话中会额外预加载最终裁定报告的摘要（已满足的需求、未解决的 finding、未验证的 gate）以及工作树 diff 的概览。

### Retry 模式

选择失败任务的 **Retry** 时，TAKT 会：

1. 显示失败详情（失败 step、错误消息、最后一条 agent 消息）
2. 要求选择 workflow
3. 要求选择起点：**Resume failed position** 或 **Restart from**
4. 打开预加载失败上下文、run session 数据和 workflow 结构的 retry 对话
5. 允许通过 AI 完善指令

**Requeue** 使用相同的 workflow 和起点选择，但不打开对话，直接把任务保存为 `pending`。Retry 和 Requeue 都可以选择 **Resume**（从失败点继续，保留执行状态）或 **Restart**（从任意 step 新开始）；`workflow_call` 子 workflow 中的 step 也可以作为起点。

重新排队后，执行使用新的 namespace，因此不会继承原有 ledger，而是从空 ledger 开始。

`/go` 后 retry 对话提供与 Instruct 相同的 **Save as Task** / **Continue editing**，以及立即重新执行的 `/accept` 和 `/replay`；`/cancel` 会取消。Retry note 会追加到任务记录，并在多次 retry 中累积。

### 非交互模式（`--non-interactive`）

用于 CI/CD 脚本：

```bash
# 以文本列出所有任务
takt list --non-interactive

# 以 JSON 列出所有任务
takt list --non-interactive --format json

# 查看指定分支的 diff stat
takt list --non-interactive --action diff --branch takt/my-branch

# 合并指定分支
takt list --non-interactive --action merge --branch takt/my-branch

# 删除分支（需要 --yes）
takt list --non-interactive --action delete --branch takt/my-branch --yes

# Try merge（stage 但不 commit）
takt list --non-interactive --action try --branch takt/my-branch
```

可用 action：`diff`、`sync`、`try`、`merge`、`delete`。

## 任务目录工作流

推荐的端到端流程：

1. **`takt add`** — 创建任务；在 `.takt/tasks.yaml` 增加 pending 记录，并在 `.takt/tasks/{slug}/` 生成 `order.md`。
2. **编辑 `order.md`** — 添加详细规格、参考材料或补充文件。
3. **`takt run`**（或 `takt watch`）— 从 `tasks.yaml` 执行 pending 任务。
4. **验证输出** — 检查 `.takt/runs/{run_slug}/reports/`；run slug 可从 `tasks.yaml` 的 `run_slug` 或 `.takt/runs/` 最新目录找到。
5. **`takt list`** — 检查结果，合并成功分支，重试失败任务或追加指令。

## 隔离执行（Isolated Clone）

在任务配置中指定 `worktree` 后，每个任务会在由 `git clone` 创建的隔离 clone 中执行，保持主工作目录干净。

### 配置选项

| 设置 | 说明 |
|------|------|
| `worktree: true` | 在 `{project}/../takt-worktrees` 自动创建 clone；可由 `worktree_dir` 修改，父目录不可写时回退到项目内 `.takt/worktrees` |
| `worktree: "/path/to/dir"` | 在指定路径创建 clone |
| 省略 `worktree` | 在当前目录执行（默认） |
| `branch: "feat/xxx"` | 使用指定分支；省略时自动生成 `takt/{timestamp}-{slug}` |

### 工作原理

TAKT 使用 `git clone --reference <main-repo> --dissociate` 创建带独立 `.git` 目录的 clone；reference 仓库是 shallow 时回退到普通 `git clone`。独立 `.git` 可防止 agent 工具沿 `gitdir:` 追溯主仓库，agent 完全在 clone 内工作。

YAML 字段仍叫 `worktree` 是为了兼容；内部使用独立 clone，而不是 `git worktree`。

### 临时生命周期

1. **Create** — 执行前创建 clone
2. **Execute** — 在 clone 中运行任务
3. **Commit & Push** — 成功时自动 commit 和 push（设置 auto_pr 或类似发布选项时才 push 到 `origin`）
4. **Preserve** — 执行后保留 clone，以便 instruct/retry
5. **Cleanup** — 分支是持久产物，使用 `takt list` 合并或删除

### 双工作目录

| 目录 | 用途 |
|------|------|
| `cwd`（clone 路径） | agent 运行位置和 report 写入位置 |
| `projectCwd`（项目根目录） | 日志和 session 数据存储位置 |

worktree 执行期间，report 写入 `cwd/.takt/runs/{slug}/reports/`，防止 agent 发现主仓库路径。当 `cwd !== projectCwd` 时跳过 session resume，以避免跨目录污染。

## Session 日志

TAKT 以 NDJSON（Newline-Delimited JSON，`.jsonl`）写入 session 日志。每条记录以原子方式追加，因此进程崩溃时仍能保留部分日志。

### 日志位置

```text
.takt/runs/{slug}/
  logs/{sessionId}.jsonl   # 每次 workflow 执行的 NDJSON session 日志
  meta.json                # run 元数据（task、workflow、起止时间、状态等）
  operations/
    journal.json           # 操作 journal（内部执行记录）
  context/
    previous_responses/
      latest.md            # 上一次 response（自动继承）
```

启用 observability 时，`meta.json` 还包含完成或中止后打印的 Tempo TraceQL 查询。

### Record 类型

| 类型 | 说明 |
|------|------|
| `workflow_start` | 使用 task 和 workflow 初始化 workflow |
| `step_start` | step 开始执行 |
| `step_complete` | step 结果、状态、内容和匹配规则 |
| `workflow_complete` | workflow 成功完成 |
| `workflow_abort` | workflow 中止及原因 |

### 实时监视

```bash
tail -f .takt/runs/{slug}/logs/{sessionId}.jsonl
```
