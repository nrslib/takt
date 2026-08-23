# Workflow 指南

[English](./workflows.md) | [日本語](./workflows.ja.md) | [简体中文](./workflows.zh-CN.md)

本文说明如何创建和定制 TAKT workflow。

## Workflow 基础

workflow 是定义 AI agent 执行的 step 序列的 YAML 文件。每个 step 指定：

- 使用哪个 persona
- 提供哪些指令
- 如何根据规则路由到下一步

## 文件位置

- builtin workflow 内置在 npm package 的 `dist/resources/`
- `~/.takt/workflows/` — 用户 workflow（同名时覆盖 builtin）
- 使用 `takt eject <workflow>` 将 builtin 复制到 `~/.takt/workflows/` 后定制

## Workflow 分类

要在 workflow 选择 UI 中使用分类，请配置 `workflow_categories`。详见[配置指南](./configuration.zh-CN.md#workflow-categories)。

## 创建 Workflow 文件

使用 `takt workflow init <name>` 在 `.takt/workflows/` 创建自定义 workflow scaffold；传入 `--global` 时创建到 `~/.takt/workflows/`。

- `--template minimal`：生成带通用 step 路由的自包含 scaffold
- `--template faceted`：生成 workflow 以及本地 persona/instruction facet 文件

编辑后运行 `takt workflow doctor <name or path>`，在执行前验证引用、路由目标和不可达 step。

## Workflow Schema

```yaml
name: my-workflow
description: Optional description
max_steps: 10
initial_step: first-step          # 可选，默认第一个 step

all_steps:
  rules:
    - findings-handling
    - ref: careful-findings
      position: before_instruction

# Section map（key → 相对于 workflow YAML 的文件路径）
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md
policies:
  coding: ../facets/policies/coding.md
  review: ../facets/policies/review.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
instructions:
  plan: ../facets/instructions/plan.md
  implement: ../facets/instructions/implement.md
report_formats:
  plan: ../facets/output-contracts/plan.md

steps:
  - name: step-name
    session_key: shared-coder        # 可选：此 step 的显式 session key
    persona: coder                   # persona key（引用 personas map）
    persona_name: coder              # 显示名称（可选，不影响 provider_routing.personas）
    tags: [implementation, edit]     # provider routing tag（可选）
    policy: coding                   # policy key（单值或数组）
    knowledge: architecture          # knowledge key（单值或数组）
    edit: true                       # step 是否可以编辑文件
    required_permission_mode: edit   # 最低权限：readonly、edit 或 full
    capabilities: edit               # 可选 capability preset
    rules:
      - condition: "Implementation complete"
        next: next-step
      - condition: "Cannot proceed"
        next: ABORT
    instruction: |                   # 内联指令
      Your instructions here with {variables}
    output_contracts:                # Report 文件配置
      report:
        - name: 00-plan.md
          format: plan               # 引用 report_formats map
    quality_gates:                   # agent step 完成 gate
      - "Review the implementation before finishing" # AI 指令
      - type: command                # 机器执行的命令 gate
        name: quality-check
        command: "./.takt/quality-gates/check.sh"
        cwd: "."
        timeout_ms: 300000
```

step 通过 key 引用 section map（例如 `persona: coder`），而不是直接引用文件路径。section map 中的路径相对于 workflow YAML 所在目录解析。section map 可以省略；裸名称会按项目 `.takt/facets/<type>/` → 全局 `~/.takt/facets/<type>/` → `builtins/{lang}/facets/<type>/` 查找。只有需要自定义别名或显式文件路径时才需要 map。

### Workflow-wide 规则（`all_steps.rules`）

在 `all_steps.rules` 中声明应用于每个 agent step 的规则。每项可以是规则引用，也可以是带 `ref` 和可选 `position: before_instruction` 的对象。省略 `position` 时规则放在自动执行规则之后；`before_instruction` 会将它放到 `Instructions` section 之前。

规则文件是 `workflows/rules/<ref>.md`，按项目 `.takt/workflows/rules/` → 全局 `~/.takt/workflows/rules/` → builtin 目录查找。适用性提示和规则标题每个 prompt 只渲染一次。它们只影响 Phase 1 agent instruction，不影响 output report、状态路由或 companion reviewer。被调用的 workflow 会先继承父 workflow 的规则，再叠加自己的 `all_steps.rules`。规则文件不能包含 required-output heading 或 `{report:...}` 引用；省略 `all_steps` 会保留原有 prompt 行为。

### 可复用 Step Fragment

在 `steps/` 目录下创建只包含一个 step 对象的根级 `<name>.yaml` 或 `<name>.yml`，再使用 `uses` 引用：

```yaml
steps:
  - name: final-gate
    uses: final-gate
    rules:
      - condition: COMPLETE
        next: COMPLETE
```

例如 `.takt/steps/final-gate.yaml` 可以是：

```yaml
kind: workflow_call
call: supervisor-final-gate
```

每个声明 `uses` 的具体 workflow step（包括 parallel 子 step）都必须在调用位置声明自己的非空规则。非 parallel 调用方使用 `rules` 数组；parallel 调用方使用下面的 rule tree。fragment 根部不能声明 `rules`，因为路由必须由知道目标 step 名称的 workflow 拥有；loader 不会复制、继承或合成 fallback 规则。

Fragment 可以在根级 `params` 中声明类型化参数，调用方通过 `with` 绑定。支持的参数类型包括 `facet_ref`、`facet_ref[]`（配合 `facet_kind: policy`、`knowledge`、`instruction`、`persona` 或 `report_format`）、`workflow_ref` 和 `facet_pool_ref`。可调用 workflow 的参数还可以通过 `workflow_call.args` 传入。用 `{ $param: name }` 引用参数；嵌套 fragment 使用词法作用域，必须显式通过 `with` 转发，不能隐式捕获外层参数。

Fragment 不支持可选参数或默认参数。loader 会在 schema validation 前消费 `params`、`with` 和参数引用，验证缺失/未知绑定、类型或 cardinality 不匹配，并保留 `workflow_call` fragment 自身的 `args`。未展开的 `$param`、不支持字段中的参数引用以及未知 facet 都会在加载时失败。

可调用 workflow 可以通过 `facet_pool_ref` 参数选择子 workflow 的本地实现 pool，而无需复制 fragment 定义：

```yaml
subworkflow:
  callable: true
  params:
    implementation_pool:
      type: facet_pool_ref
      default: coding-facets

facet_pools:
  coding-facets:
    candidates:
      - id: backend
        description: Handle backend changes
        knowledge: backend

steps:
  - name: implement
    uses: implementation-step
    with:
      implementation_pool:
        $param: implementation_pool
    dynamic_facets:
      pool:
        $param: implementation_pool
```

当 fragment 展开为 parallel step 时，调用方必须提供严格的 rule tree：`self` 是 parallel parent 的规则数组，`parallel` 为每个唯一最终 child name 映射规则数组；必须恰好列出所有 child。

```yaml
steps:
  - name: reviewers
    uses: reviewers
    rules:
      self:
        - condition: all("approved")
          next: COMPLETE
      parallel:
        architecture:
          - condition: approved
          - condition: needs_fix
        security:
          - condition: approved
          - condition: needs_fix
```

对象字段深合并；`parallel` 等数组整体替换。名称按调用方 `name` → fragment `name` → `uses` 最终名称解析。fragment 可以引用其他 fragment，但循环引用会失败。裸名称按项目、全局、所选语言 builtin 的 `steps/` 查找；`@owner/repo/name` 显式选择 repertoire package。最多展开 64 层、总计 512 个引用；每个 fragment 必须是可读的普通文件且不超过 1 MiB。绝对路径、遍历、符号链接逃逸、不可读文件、循环引用和未知引用都是配置错误。

## 可用变量

| 变量 | 说明 |
|------|------|
| `{task}` | 原始用户请求（自动注入） |
| `{iteration}` | workflow 总 turn 数（执行的 step 总数） |
| `{max_steps}` | 允许的最大 step 数 |
| `{step_iteration}` | 当前 step 执行次数 |
| `{previous_response}` | 上一个 step 的输出（自动注入） |
| `{user_inputs}` | workflow 中额外的用户输入（自动注入） |
| `{report_dir}` | report 目录路径，例如 `.takt/runs/20250126-143052-task-summary/reports` |
| `{report:filename}` | 内联 `{report_dir}/filename` 内容 |
| `{review_scope}` | TAKT 计算出的本任务变更文件列表 |

`{review_scope}` 包括工作树中的 committed changes、未提交 changes 和未跟踪文件（忽略文件除外）；PR-derived run 还会加入 PR 的 `base...head` diff。非 Git 目录或未检测到变更时会明确说明，而不是返回空字符串。列表超过 200 个文件时会显示剩余数量。通用 builtin reviewer 会自动获得该变量。

`{task}`、`{previous_response}` 和 `{user_inputs}` 会自动注入 instruction；只有需要控制它们在模板中位置时才需要显式占位符。

## Rules

Rules 决定每个 step 如何路由到下一个 step。instruction builder 会自动注入状态输出规则，让 agent 知道应输出哪些 tag。

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Cannot proceed"
    next: ABORT
    appendix: |
      Explain what is blocking progress.
```

### Rule 条件类型

| 类型 | 语法 | 说明 |
|------|------|------|
| Semantic label | `approved` | status judge 选择一次去重后的 label |
| State predicate | `when(...)` | 确定性地评估 workflow state |
| Aggregate | `all("X")` / `any("X")` | 聚合 parallel 子 step 结果 |
| Combined | `approved && when(...)` | 同时要求 label 和 state predicate |
| Aggregate + state | `all("X") && when(...)` / `any("X") && when(...)` | 同时要求 aggregate 和 state predicate |

规则按 YAML 顺序计算，选择第一个匹配项；不会按规则类型优先，也没有 fallback transition。没有规则匹配时 workflow 以 `rule_no_match` 中止。

### 特殊 `next` 值

- `COMPLETE` — workflow 成功结束
- `ABORT` — workflow 失败结束

### `appendix`

可选的 `appendix` 是该规则匹配时附加 AI 输出的模板，适合结构化错误报告或要求特定信息。

### `interactive_only`

`interactive_only: true` 的规则只在交互执行中考虑。`--pipeline` 或 `takt run` 等非交互运行会跳过它，就像该规则未声明一样。可用于需要人工输入的转移。

## Step 类型

TAKT 支持 Normal、Parallel、Dynamic Parallel、Arpeggio、Team Leader、Workflow Call 和 System 七种 step 类型。

### Normal Step

单个 agent 执行 step；前面示例都是 Normal step。

### Parallel Step

子 step 并发执行，parent 通过 `all()` / `any()` 聚合结果：

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        session_key: arch-review
        persona: architecture-reviewer
        policy: review
        knowledge: architecture
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
        session_key: security-review
        persona: security-reviewer
        policy: review
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-security
    rules:
      - condition: all("approved")
        next: COMPLETE
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`：所有子 step 都匹配 X 时为真
- `any("X")`：任意子 step 匹配 X 时为真
- 子 step 的 `rules` 定义可能结果；`next` 可省略，由 parent 路由
- parallel 子 step 不支持 `promotion`
- parent 可设置 `concurrency: <N>`（最小 1）限制并发数；省略时全部同时启动

### Dynamic Parallel Step

`parallel` 也可以定义固定集合和可选 pool。进入 step 时 TAKT 运行内部 selector；selector 不是 workflow step，不能创建 agent 或改变 workflow。selector 使用新 session 和只读权限，只能使用 `Read`、`Glob`、`Grep`（provider 遵守 allowlist 时）。

```yaml
  - name: reviewers
    parallel:
      fixed:
        - name: architecture
          persona: architecture-reviewer
          instruction: Review architecture
          rules: [{ condition: approved }]
      pool:
        - name: frontend
          persona: frontend-reviewer
          description: Review frontend and UI changes
          instruction: Review frontend
          rules: [{ condition: approved }]
        - name: backend
          persona: backend-reviewer
          description: Review API and persistence changes
          instruction: Review backend
          rules: [{ condition: approved }]
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
```

`pool` 必须非空，且每个 pool item 都需要非空 `description`。`fixed` 总是运行，selector 只能选择展开后的 pool step name。`replace`（默认）在新 round 替换上一轮 pool selection；`cumulative` 保留之前选中的 item。恢复运行不会恢复保存的 selection，而是针对当前 pool 再次调用 selector。

`all()` 和 `any()` 只聚合当前 round 的 fixed 与 selected pool item。selector 输出无效或选择未知项时，在任何 agent 启动前失败；没有 all-pool fallback。缺失/空 pool、重复展开名称、非 agent 子 step、无效 selection mode、provider 未解析、严格 structured output 无效或 fixed 加 selected 为空都会在执行前失败。Selector 输入包括任务、Report Directory 路径、目标 report 名称、相对 `HEAD` 的变更文件路径、candidate ID/description、`cumulative` 的上一轮 selection 以及是否首次进入/新 round。报告引用按当前 scope、resume snapshot 和父 scope 解析；读取工具只允许 `Read`、`Glob` 和 `Grep`。

### Dynamic Facet Selection（Facet Pool）

Normal agent step 或 parallel 子 step 可以在 agent 启动前从经过验证的 candidate pool 动态选择额外的 `policy` 和 `knowledge` facet。固定 facet 始终保留，只附加当前情况需要的 facet。

在 workflow 顶层 `facet_pools` 定义 pool，再通过 step 的 `dynamic_facets` 引用。pool 可以内联，也可以使用外部资源文件。

#### 内联 Pool

内联 pool 中的 candidate facet 引用使用 workflow 自己的 `policies` / `knowledge` section map，或同一 facet 命名空间中的裸名称。

```yaml
name: backend-fix

policies:
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md
knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md

facet_pools:
  fix:
    candidates:
      - id: backend
        description: Handle API, repository, and server-side implementation
        knowledge: backend-api
      - id: transaction
        description: Handle transaction boundaries, rollback, and concurrency control
        policy: transaction-correctness
        knowledge: database-transaction
      - id: backward-compatibility
        description: Preserve compatibility of public APIs and schemas
        policy: backward-compatibility

steps:
  - name: fix
    persona: coder
    policy: [coding, testing]
    knowledge: architecture
    dynamic_facets:
      pool: fix
      max_selected: 3
    instruction: fix
    edit: true
    rules:
      - condition: Fix complete
        next: review
```

#### Candidate contract

每个 candidate 共享以下结构：

```yaml
- id: transaction
  description: Handle transaction boundaries and rollback
  policy:
    - transaction-correctness
  knowledge:
    - database-transaction
```

`id` 必须在 pool 内非空且唯一；`description` 必须是非空字符串；`policy` 和 `knowledge` 可以是标量或非空数组，并且至少提供其中一个。一个 candidate 可以代表单个 facet 或小型 facet bundle，selector 可以选择多个 candidate。空选择表示不需要额外 facet，是合法结果；同一 pool 中任意 candidate 组合必须有效，MVP 不引入 `requires`、`conflicts_with` 或互斥组。`max_selected` 可选；未设置时最多可选择 pool 中的全部 candidate。selector 失败时没有隐式的全选或空选 fallback。

#### Parallel 子 Step

`dynamic_facets` 也可以放在 static parallel child、dynamic parallel 的 fixed 或 pool item 上。participant selector 先运行，只有被选中的 child 才执行 facet selector；所有适用 selector 完成后才启动 parallel child。

```yaml
facet_pools:
  security-review:
    candidates:
      - id: web
        description: Review HTTP and browser security boundaries
        knowledge: [security-web, security-api]
      - id: cli
        description: Review command-line and local process boundaries
        knowledge: security-local

steps:
  - name: reviewers
    parallel:
      pool:
        - name: security-review
          description: Review security for the selected system
          persona: security-reviewer
          knowledge: security
          dynamic_facets:
            pool: security-review
            max_selected: 1
          instruction: review-security
          rules: [{ condition: approved }]
      selection:
        mode: replace
    rules:
      - condition: all("approved")
        next: COMPLETE
```

无效 pool、candidate ID 或 `max_selected` 会阻止该 child 及同一 parent 下的 sibling 启动。对于嵌套 callable workflow，应让拥有该 pool 的顶层 workflow 选择狭窄的 adapter，而不要把 pool 参数扩散到每个可能的 callable target；未声明的 callable 参数会在加载时被拒绝。

#### Facet composition

动态 facet 的有效组合为：

```text
effective policy    = fixed policy    + selected dynamic policy
effective knowledge = fixed knowledge + selected dynamic knowledge
```

固定 facet 在前，动态 facet 按 pool 定义顺序追加；selector 返回顺序不改变 facet 顺序。重复的同一 resolved facet 会去重，固定侧优先。安全、隐私、授权和强制质量条件应放在固定侧。动态 facet 不能修改 persona、instruction、provider、permission、MCP、tools 或 output contract。

#### Rounds、session 与 resume

每次重新进入同一 step 作为新 round 时都会重新选择并替换上一次动态 selection；没有 cumulative 模式：

```text
round 1: selects frontend
round 2: selects transaction

round 2 effective facets:
  fixed + transaction
```

主 agent session 按 round 隔离；进程 resume 从空的 run-local selection 开始并重新调用 selector。动态选择变化只在下一次到达 step 时生效。selector 结果和解析后的有效 facet 集会在主 agent 启动前写入 runtime state；加载时内联和外部 pool 会统一为同一种 resolved pool，执行阶段不会根据来源分支。MVP 不支持执行期间热切换 facet。

#### External pool

外部 pool 可以这样引用：

```yaml
facet_pools:
  fix:
    uses: implementation-fix
```

`facet-pools/implementation-fix.yaml` 必须只定义一个 pool 资源；它的 facet 引用只在该文件自己的 section map 中解析：

```yaml
policies:
  transaction-correctness: ../facets/policies/transaction-correctness.md
  backward-compatibility: ../facets/policies/backward-compatibility.md

knowledge:
  backend-api: ../facets/knowledge/backend-api.md
  database-transaction: ../facets/knowledge/database-transaction.md

candidates:
  - id: backend
    description: Handle API, repository, and server-side implementation
    knowledge: backend-api
  - id: transaction
    description: Handle transaction boundaries, rollback, and concurrency control
    policy: transaction-correctness
    knowledge: database-transaction
  - id: backward-compatibility
    description: Preserve compatibility of public APIs and schemas
    policy: backward-compatibility
```

外部 pool 不支持嵌套 `uses`、`params` 或 `$param`，也不能与内联 `policies`、`knowledge`、`candidates` 混用。

#### External pool lookup

查找顺序是 repertoire package 本地、项目 `.takt/facet-pools/`、全局 `$TAKT_CONFIG_DIR/facet-pools/`、`builtins/<lang>/facet-pools/`、共享 builtin `builtins/facet-pools/`；每层先查 `<name>.yaml` 再查 `<name>.yml`。`@owner/repo/name` 显式选择 repertoire package。绝对路径、遍历、root-escaping symlink、不可读和过大的文件会被拒绝；来源和依赖资源会被跟踪，供 doctor、preview、eject 以及 repertoire install/remove 使用。

#### Selector contract

selector 使用新 session、只读权限和 `Read`/`Glob`/`Grep` 工具。输入包括用户请求、叶 workflow、workflow-call instance、step identity、round 信息、Report Directory 和 report 名称、调用时 `git diff HEAD` 对应的变更路径以及 candidate ID/description。candidate facet body 不会单独发送；selector 通过读取目标 prompt 和 report 获取所需上下文。输出必须是只含 `selected_ids` 和 `rationale` 的严格 JSON；未知/重复 ID、非数组和超出 `max_selected` 都会在主 agent 启动前失败，失败时没有 fallback。selector guidance 可以配置 `instruction`（必填）和 `persona`（可选）：

```yaml
steps:
  - name: fix
    dynamic_facets:
      pool: implementation
      selector:
        persona: facet-selector
        instruction: select-implement-facets
  - name: reviewers
    parallel:
      fixed: []
      pool:
        - name: backend
          persona: backend-reviewer
          description: Review backend changes
          instruction: Review the backend
          rules: [{ condition: approved }]
      selection:
        mode: replace
        selector:
          persona: reviewer-selector
          instruction: select-reviewers
```

#### Fail-fast conditions

在执行前加载失败的情况包括：pool schema 无效、pool 为空、candidate ID 重复、description 缺失、candidate 同时没有 `policy` 和 `knowledge`、facet 引用未知、`uses` 与内联字段混用、外部 pool 隐式引用调用方 facet namespace、外部资源 lookup/trust/文件校验失败、`dynamic_facets.pool` 未知、`max_selected` 无效或超过 candidate 数量，以及 dynamic facet 写在非 agent step 或 parallel parent 上。selector provider 无法解析、structured output 未建立、`selected_ids` 不是数组，或出现非字符串/重复/未知 ID 时，也会在主 agent 启动前失败。

#### Selector guidance

配置 selector 时，`instruction` 必填、`persona` 可选；guidance 只描述如何选择 facet 或 participant ID。证据引用、只读 structured 执行和工具、输出契约、candidate 校验、selection mode 与权限绕过禁用仍由 TAKT 负责。selector 不能改变 selected agent 的 persona、instruction、provider、权限、tools、MCP 或 output contract。未知 selector key、空 selector、缺少 instruction 或无法解析的 persona/instruction 会在校验时失败。

#### Packages、eject 与 authoring tools

Repertoire package 可以安装/移除 `facet-pools/`；`takt workflow eject` 会复制外部 pool 及其 facet 依赖；`takt workflow doctor` 校验 pool、candidate 和 facet 引用；`takt workflow preview` 显示 pool 名称、candidate ID、引用的 facet 和来源。builtin en/ja pool（如果提供）应保持相同的 candidate ID 集合。

### Arpeggio Step

从 CSV、JSON 等 data source 读取数据，并以受限并发对每行应用相同 step 模板：

```yaml
  - name: batch-process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data/items.csv
      batch_size: 5
      concurrency: 3
      template: ./templates/process.txt
      max_retries: 2
      retry_delay_ms: 1000
      merge:
        strategy: concat
        separator: "\n---\n"
      output_path: ./output/result.txt
    rules:
      - condition: "Processing complete"
        next: COMPLETE
```

`merge.strategy` 可以是默认的 `concat` 或 `custom`。`concat` 拼接每行结果，不接受 `inline_js` 或 `file`；`custom` 必须提供其中一个。用于批量处理文件列表、Issue 列表或生成的测试用例。

### Team Leader Step

Team Leader agent 在运行时将任务分解成独立子部分，并把每部分派给 worker agent：

```yaml
  - name: implement
    team_leader:
      max_concurrency: 2
      initial_max_parts: 2
      timeout_ms: 600000
      inspect_tools: [read, glob, grep]
      part_tags: [coding]
      part_persona: coder
      part_edit: true
      part_permission_mode: edit
      part_allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
    instruction: |
      Decompose this task into independent subtasks.
    rules:
      - condition: "All parts completed"
        next: review
```

`max_concurrency` 和兼容 key `max_parts` 最大为 3；均省略时默认 3。`initial_max_parts` 只限制第一批分解。每批完成后才请求下一批，因此同一批的 parts 不应互相依赖。`part_tags` 设置生成 part step 的 provider routing tags；省略时继承父 step 的 tags。`inspect_tools` 只控制分解阶段的只读工具，生成的 child part 工具由 `part_allowed_tools` 单独控制。

### Workflow Call Step（Subworkflow）

一个 step 调用另一个 workflow。子 workflow 在同一次 run 中运行，结果通过父级 `rules` 路由：

```yaml
  - name: peer-review
    kind: workflow_call
    call: peer-review
    args:
      impl_knowledge: cqrs-es
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: fix
```

子 workflow 可以通过 `subworkflow.params` 声明参数，父级用 `args` 传值。`workflow_call` 规则只能使用 `COMPLETE`、`ABORT` 或子 workflow 在 `subworkflow.returns` 中声明的 semantic return label。子 step 使用 `return:` 结束子 workflow，父级再按该 label 路由。

`workflow_call` 不接受 provider、model、provider-options 或 routing override；子 workflow 继承父级已经解析的 runtime context，provider target/profile/options/routing 必须在 `runtime.yaml` 配置。`max_steps` 由根 workflow 拥有并在所有后代之间共享，workflow_call 本身不消耗预算。

可调用 workflow 还可以通过 `vars` 传递非 facet 的执行上下文；agent instruction 用 `{var:name}` 读取。嵌套调用会继承字符串、有限数字和布尔值，重新声明同名 key 时覆盖父值；缺失值会渲染为 `unspecified`，instruction 可以据此显式定义安全 fallback。`workflow_call` 是 control node，不是 agent step。

```yaml
- name: follow-up-review
  kind: workflow_call
  call: peer-review-suite
  vars:
    review_mode: follow_up
  rules:
    - condition: COMPLETE
      next: COMPLETE
```

### System Step

System step 由 TAKT engine 执行，不启动 agent。使用 `kind: system` 或简写 `mode: system`，两者不能同时声明。System step 不能声明 `persona`、`instruction`、`provider`、`structured_output`、`output_contracts` 或 `quality_gates` 等 agent 字段。

`system_inputs` 从 engine context 读取并通过 `as` 绑定名称；支持 `task_context`、`branch_context`、`pr_context`、`issue_context`、`task_queue_context`、`pr_list`、`pr_selection`、`issue_list` 和 `issue_selection`。绑定的值可通过 `when(context.<step>.<binding>...)` 使用，也可在后续 agent instruction 中使用 `{context:step.binding.field}`：

```yaml
  - name: route_context
    mode: system
    system_inputs:
      - type: task_queue_context
        source: current_project
        as: active_queue
        exclude_current_task: true
      - type: pr_selection
        source: current_project
        as: selected_pr
    rules:
      - condition: when(context.route_context.active_queue.pending_count > 0)
        next: wait_before_next_scan
      - condition: when(context.route_context.selected_pr.exists == true)
        next: plan_from_existing_pr
```

`effects` 执行 engine-side action：`enqueue_task`、`comment_pr`、`sync_with_root`、`resolve_conflicts_with_ai`、`merge_pr` 和 `close_pr`。每种 effect 在一个 step 中最多一次，结果通过 `when(effect.<step>.<type>.<field>)` 路由。

```yaml
  - name: prepare_merge
    mode: system
    effects:
      - type: sync_with_root
        pr: "{context:route_context.selected_pr.number}"
    rules:
      - condition: when(effect.prepare_merge.sync_with_root.success == true)
        next: merge_pr
      - condition: when(effect.prepare_merge.sync_with_root.conflicted == true)
        next: resolve_conflicts
```

System step 可与 agent step 的 `structured_output` 配合：agent step 使用 `structured_output: { schema_ref: <name> }`，引用顶层 `schemas:` map；验证后的字段可用于 `when(structured.<step>.<field> ...)` 和 `{structured:step.field}`。`structured_output` 不属于 system step。

## Output Contract（Report 文件）

Step 可以在 report 目录生成 report 文件：

```yaml
# 使用 report_formats map 的单个 report
output_contracts:
  report:
    - name: 00-plan.md
      format: plan

# 内联 format
output_contracts:
  report:
    - name: 00-plan.md
      format: |
        # Plan
        ...

# 多个 report
output_contracts:
  report:
    - name: 01-scope.md
      format: scope
    - name: 02-decisions.md
      format: decisions
```

每项必须有 `name` 和 `format`。可选字段：`use_judge`（默认 `true`，决定 report 是否作为 Phase 3 status judgment 证据）和 `order`（替换默认 report-writing instruction 的 report-format facet）。需要 judgment 的规则至少保留一个 `use_judge` report。

## Runtime Provider Promotion

Workflow promotion 只推进 `runtime.yaml` 选择的 ladder。每项必须严格是 `{at: N}`；provider、model、provider-options 和 condition 字段会在加载时被拒绝：

```yaml
steps:
  - name: review
    persona: reviewer
    promotion:
      - at: 3
      - at: 6
```

每个阶段的 provider/model/options 在 `runtime.yaml` 定义。parallel 子 step 不支持 promotion。

## Step 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `description` | - | step 描述；dynamic parallel pool item 必须使用非空值 |
| `persona` | - | persona key 或裸 facet 名称 |
| `persona_name` | - | 日志和 prompt 中的显示名，不影响 routing |
| `session_key` | - | normal agent step 和 parallel 子 step 的显式 session key；provider 会追加到 runtime key |
| `session` | `continue` | `continue` 恢复 session，`refresh` 不恢复，`compact` 恢复后在 Phase 1 前请求 provider 压缩 |
| `requires_user_input` | `false` | 标记可等待用户输入的 normal agent step；需要交互模式和 input handler |
| `tags` | - | 按顺序与配置中的 `provider_routing.tags` 匹配 |
| `policy` | - | policy key 或数组 |
| `knowledge` | - | knowledge key 或数组 |
| `instruction` | - | instruction key |
| `edit` | - | 是否可以编辑项目文件 |
| `companion` | - | 与 normal agent step 并行运行 companion reviewer |
| `completion_retry` | - | opt-in 的 reviewer 完整性检查与有界重试 |
| `pass_previous_response` | `true` | 将上一个 step 输出传给 `{previous_response}` |
| `capabilities` | - | capability preset；解析工具、网络、sandbox 和 skill，不选择 provider/model |
| `mcp_servers` | - | step 级 MCP server 配置 |
| `allow_git_commit` | `false` | 允许 instruction 中执行 `git add` / `commit` / `push` |
| `required_permission_mode` | - | 最低权限：`readonly`、`edit` 或 `full` |
| `output_contracts` | - | report 文件配置 |
| `quality_gates` | - | agent step 完成 gate；字符串是 AI 指令，`type: command` 是机器 gate |

`completion_retry` 是只接受对象的显式 opt-in，要求 `retry_instruction`，可选 `min_retry` 与 `max_retry`。`max_retry` 未设置时内部上限为 4；`review_completion` 仍是已弃用别名，不能与 `completion_retry` 同时使用。Provider 和 model 不是 workflow 字段，必须由 runtime profile/routing 提供；workflow 中写入已移除字段会在加载边界失败。

## Workflow 级配置

### `max_steps`

run 的迭代预算必须是正整数，或用于持续循环 workflow 的 `infinite`：

```yaml
max_steps: infinite
```

根 workflow 拥有预算，可调用的子 workflow 不能声明自己的 `max_steps`。

### `schemas`

`structured_output.schema_ref` 映射到 schema 名称。文件按项目 `.takt/schemas/` → `~/.takt/schemas/` → bundled `schemas/` 查找：

```yaml
schemas:
  followup-task: followup-task
  pr-followup-task: pr-followup-task
```

### Provider Routing 与自动路由

`auto_routing`、provider/model 默认值、provider options 和 routing 都不是 workflow YAML 字段。它们由 `runtime.yaml`（或保留的旧版 `config.yaml`）管理。workflow YAML 中唯一的 provider option surface 是 `capabilities`；`rate_limit_fallback` 也不能写进 workflow YAML。

### `interactive_mode`

`takt` 不带参数时使用的默认交互模式，可选 `assistant`（默认）、`grill-me`、`passthrough`、`quiet`、`persona`：

```yaml
interactive_mode: assistant
```

### 已移除的 Workflow 执行设置

`workflow_config.provider`、`workflow_config.model`、`workflow_config.provider_options`、step `provider`/`model`/`provider_options`、`loop_monitors.judge` 的 provider 设置以及 `workflow_call.overrides` 都会被拒绝。请迁移到 `runtime.yaml`；`workflow_config.runtime.prepare` 仍然支持。

### `capabilities`

`capabilities` 可以在 workflow 顶层、step 或 parallel 子 step 使用。step 自己的值替换 workflow 默认值；数组按从左到右合并。常见 preset 是 `readonly`、`edit` 和 `enable-skills`，只能引用 capability preset，不能写内联 provider option。`system` 和 `workflow_call` 不接受 `capabilities`。preset 只能提供 `allowed_tools`、`network_access`、`sandbox` 和 `skills` 等能力 leaf；`effort`、`base_url`、`guards` 等质量或机器配置必须放入 `runtime.yaml`。

```yaml
capabilities: readonly

steps:
  - name: implement
    capabilities: [edit, enable-skills]
```

### `workflow_config.runtime`

在 workflow 执行前准备运行环境。builtin `node`/`gradle` preset 始终允许；自定义脚本需要 `workflow_runtime_prepare.custom_scripts: true`：

```yaml
workflow_config:
  runtime:
    prepare: [node, gradle, ./custom-script.sh]
```

### `loop_monitors`

检测 step 间循环并让 AI judge 判断是否取得进展：

```yaml
loop_monitors:
  - cycle: [review, fix]
    ignore_steps: [verify]
    threshold: 3
    judge:
      persona: supervisor
      instruction: "Evaluate if the fix loop is making progress..."
      rules:
        - condition: "Progress is being made"
          next: fix
        - condition: "No progress"
          next: ABORT
```

`loop_monitors.judge` 不接受 provider、model 或 provider-options；使用 `provider.targets.internal_agents.loop-judge` 的 runtime target 或触发 step 的 fallback。judge 始终使用新 session，因此不接受 `session_key`。限流 fallback 也必须在 runtime 或旧版 config 中配置。

### `subworkflow`

可调用 workflow 可以这样声明参数：

```yaml
subworkflow:
  callable: true
  visibility: internal
  params:
    impl_knowledge:
      type: facet_ref[]
      facet_kind: knowledge
      default: []
    supervisor_persona:
      type: facet_ref
      facet_kind: persona
      default: supervisor
    reviewer_suite:
      type: workflow_ref
      default: peer-review-suite-base
```

`facet_ref`、`facet_ref[]` 使用 `facet_kind`：`policy`、`knowledge`、`instruction`、`persona` 或 `report_format`。`workflow_ref` 用于 `call: { $param: reviewer_suite }`；`facet_pool_ref` 用于 `dynamic_facets.pool`；`companion_ref[]` 用于普通 agent step 的固定 companion。参数默认值可选，数组参数可以为空；`facet_ref[]` 在 `policy` 或 `knowledge` 中会在原位置展开，`facet_pool_ref` 必须是 child 顶层 `facet_pools` 的标量 key，`companion_ref[]` 的空数组会省略 `companion` 字段。未知 child-local pool、未展开参数、非数组 companion 参数和未知 companion 定义都会在执行前失败。

## 示例

### 简单实现 Workflow

```yaml
name: simple-impl
max_steps: 5

personas:
  coder: ../facets/personas/coder.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    capabilities: edit
    rules:
      - condition: Implementation complete
        next: COMPLETE
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      Implement the requested changes.
```

### 带审查的 Workflow

```yaml
name: with-review
max_steps: 10

personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    capabilities: edit
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      Implement the requested changes.

  - name: review
    persona: reviewer
    edit: false
    capabilities: readonly
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction: |
      Review the implementation for code quality and best practices.
```

### 在 Step 间传递数据

```yaml
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md

steps:
  - name: analyze
    persona: planner
    edit: false
    capabilities: readonly
    rules:
      - condition: Analysis complete
        next: implement
    instruction: |
      Analyze this request and create a plan.

  - name: implement
    persona: coder
    edit: true
    pass_previous_response: true
    required_permission_mode: edit
    capabilities: edit
    rules:
      - condition: Implementation complete
        next: COMPLETE
    instruction: |
      Implement based on this analysis:
      {previous_response}
```

## Companion Reviewer

在普通 agent step 上增加 `companion`，即可在主 agent 编辑时运行无状态、只读 reviewer。列表形式选择固定 reviewer；对象形式可以组合 fixed、启动时选择一次的 pool 和可选 moderator，最多同时运行三个 reviewer。

Companion 默认禁用；在 `runtime.yaml` 设置 `companion.enabled: true` 才会运行 workflow 声明的 companion。

在 `runtime.yaml` 设置 `companion.review_mode` 选择触发策略。默认值是 `completion`：
implementer 成功响应完成后、workflow 继续前审查累计 diff，响应期间不使用 quiet、forced
或 commit 触发。已接受的 finding 仍通过现有 follow-up prompt 传递。设置为 `live` 可保留
现有的 quiet、forced、commit、queue 和 completion drain 行为。该设置只支持 global 或
project 层级，不支持 step 或 Companion 定义级覆盖。

```yaml
- name: implement
  persona: coder
  companion:
    fixed: [security-reviewer]
    pool: [design-reviewer, frontend-reviewer]
    moderator: adjudicator
  rules:
    - condition: implementation complete
      next: final-review
```

workflow transition rule 不能引用 `companion.*` state。companion finding 和 failure 是 advisory diagnostic；主 workflow 仍由普通 semantic condition 和 Phase 3 judgment 控制。定义文件按 `.takt/companions/` → `~/.takt/companions/` → `builtins/{language}/companions/` 查找，只能包含名称、描述、facet 引用和 `interval_ms`，不能包含 provider/tool 设置；`interval_ms` 必须是 1 到 `2,147,483,647` 的正整数。

在 `live` mode，TAKT 观察 mutating tool event，并在 quiet period、强制间隔或 commit 触发后审查当前累计 diff。在 `completion` mode，TAKT 等待 implementer 响应边界再审查。每个 round 使用新的 finding list；可选 moderator 按 round-local index 接受或拒绝 finding。已接受 finding 以 NDJSON 写入 `.takt/runs/{run}/companion/{step}/{companion}.jsonl`。在 implementer 每个 turn 边界，未传递的 finding 会直接嵌入 follow-up prompt，然后清空内存缓冲；implementer 决定是否处理并说明不处理原因。完成时停止新触发、排空 review round，只有 diff digest 未审查时才执行 completion review。取消通过 workflow 或 step abort signal 终止 follow-up loop；follow-up 的错误、限流或 blocked 会停止 follow-up，并继续使用最近一次成功的 implementer response。

## 最佳实践

1. **控制迭代数** — 开发 workflow 通常使用 10-30 次
2. **审查 step 使用 `edit: false`** — 防止 reviewer 修改代码
3. **使用描述性 step 名称** — 便于阅读日志
4. **逐步测试 workflow** — 从简单版本开始再增加复杂度
5. **使用 `takt eject` 定制** — 先复制 builtin workflow，而不是从零编写
