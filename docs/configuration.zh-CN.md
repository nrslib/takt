# 配置

[English](./configuration.md) | [日本語](./configuration.ja.md) | [简体中文](./configuration.zh-CN.md)

本文参考 TAKT 的配置选项。快速开始请参阅主 [README](../README.md)。阶段级 usage event 与分析请参阅 [Observability Guide](./observability.md)。

## 全局配置

在 `~/.takt/config.yaml` 中配置 TAKT 默认值。首次运行时会自动创建该文件，所有字段均可省略。

```yaml
# ~/.takt/config.yaml
language: en                  # UI 语言：'en' 或 'ja'
logging:
  level: info                 # 日志级别：debug、info、warn、error
provider: claude-sdk              # 默认 provider：claude-sdk、claude、claude-headless、claude-terminal、codex、opencode、deepseek-harness、cursor、copilot、kiro、pi 或 mock
model: sonnet                 # 默认 model（可省略，原样传给 provider）
branch_name_strategy: romaji  # 分支名生成策略：'romaji'（快）或 'ai'（慢）
prevent_sleep: false          # 执行期间阻止 macOS 空闲睡眠（caffeinate）
notification_sound: true      # 启用/禁用通知音
notification_sound_events:    # 可选的事件级开关（默认所有事件启用）
  iteration_limit: false      # 示例：将此事件设为 false 即可只禁用它
  workflow_complete: true
  workflow_abort: true
  run_complete: true
  run_abort: true
concurrency: 1                # takt run / takt watch 的并行任务数（1-10，默认 1 = 顺序执行）
task_poll_interval_ms: 500    # takt run / takt watch 检查新任务的间隔（100-5000，默认 500）
interactive_preview_steps: 3  # 交互模式中的 step 预览数（0-10，默认 3）
auto_requeue_max_attempts: 0  # takt run / takt watch 期间失败 workflow task 的自动 requeue 次数（非负整数，默认 0 = 禁用）
ignore_exceed: false          # 对 takt run 和 takt watch 应用 --ignore-exceed（默认 false）
assistant:
  formal_spec:
    mode: 'y/N'                # Alloy/Quint 模式：true、false、Y/n 或 y/N（默认 y/N）
    comments: true             # 为每个形式结构添加自然语言含义注释（默认 true）
    model_check_timeout_seconds: 900  # /verify 中 quint verify 与 Alloy 模型检查的上限秒数，1～86400 的整数（默认 900）
# auto_fetch: false           # 创建 clone 前 fetch remote（默认 false）
# base_branch: main           # 创建 clone 的基分支（默认使用 remote 默认分支）

# 运行环境默认值（除非 workflow_config.runtime 覆盖，否则应用于所有 workflow）
# runtime:
#   prepare:
#     - gradle    # 在 .runtime/ 中准备 Gradle 缓存/配置
#     - node      # 在 .runtime/ 中准备 npm 缓存/配置

# workflow step 的 provider routing（推荐）
# 按原始 persona key、step tag 或 step 名称路由，无需复制 workflow
# provider_routing:
#   personas:
#     coder:
#       provider: codex
#       model: gpt-5
#       provider_options:
#         codex:
#           reasoning_effort: high
#   tags:
#     implementation:
#       provider: codex
#       model: gpt-5
#     review:
#       provider: opencode
#       model: opencode/qwen3-coder-next
#     final-gate:
#       provider: codex
#       model: gpt-5
#       provider_options:
#         codex:
#           reasoning_effort: high
#     edit:
#       provider_options:
#         codex:
#           network_access: true
#   steps:
#     ai-antipattern-review-2nd:
#       provider: opencode
#       model: opencode/qwen3-coder-next

# 旧版按显示名称覆盖（已弃用；新配置请使用 provider_routing）
# persona_providers:
#   coder:
#     provider: codex
#     model: gpt-5

# provider 专属权限 profile（可选）
# 优先级：项目覆盖 > 全局覆盖 > 项目默认 > 全局默认 > required_permission_mode（下限）
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly
#   claude-sdk:
#     default_permission_mode: edit

# API key 配置（可选）
# 可由 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY 覆盖。DeepSeek Harness 使用官方 credential store（$DSH_HOME/.credentials.yaml，默认 ~/.dsh/.credentials.yaml）或 DEEPSEEK_API_KEY，可选 DEEPSEEK_BASE_URL，而不是 YAML API key 字段。
# anthropic_api_key: sk-ant-...  # Claude（Anthropic）
# openai_api_key: sk-...         # Codex（OpenAI）
# opencode_api_key: ...          # OpenCode
# cursor_api_key: ...            # Cursor Agent（可选；也支持登录 session）
# copilot_github_token: ...      # Copilot（GitHub token）
# kiro_api_key: ...              # Kiro CLI

# CLI 路径覆盖（可选）
# 覆盖 provider CLI 二进制文件（必须是可执行文件的绝对路径）
# 可由 TAKT_CLAUDE_CLI_PATH / TAKT_CODEX_CLI_PATH / TAKT_CURSOR_CLI_PATH / TAKT_COPILOT_CLI_PATH / TAKT_KIRO_CLI_PATH 覆盖
# claude_cli_path: /usr/local/bin/claude
# codex_cli_path: /usr/local/bin/codex
# cursor_cli_path: /usr/local/bin/cursor-agent
# copilot_cli_path: /usr/local/bin/github-copilot-cli
# kiro_cli_path: /usr/local/bin/kiro-cli

# VCS provider（可选）
# 根据 git remote URL 自动检测（github.com → github，gitlab.com → gitlab）
# 自托管实例可显式指定
# vcs_provider: github                   # 'github' 或 'gitlab'

# Assistant provider（可选）
# 路由 assistant 对话（交互规划、已有任务的 instruct、retry 对话）和 Report 阶段 fallback provider。
# Report fallback 只在 OpenCode report retry 失败后使用。
# 项目 assistant 覆盖全局 assistant；未设置 assistant 时，Report fallback 不会回退到顶层 provider/model。
# takt_providers:
#   assistant:
#     provider: claude-sdk
#     model: opus
#   selector:              # dynamic parallel、dynamic_facets 和 companion pool 的可选 selector 覆盖
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` 是可选项。provider/model 的优先级为显式 CLI 或环境变量覆盖、项目 selector、全局 selector、项目顶层、全局顶层。model 只有在其 candidate 属于解析出的 provider 时才有效。只有 selector 条目提供 `provider_options`，并按 option leaf 从全局到项目合并；顶层、persona 和 pool sub-step 的 options 不会传给 selector。provider option 的环境变量覆盖只应用于已解析的 selector provider。Codex selector 使用 `config_profile` 时，selector 自身的有效 options（selector 条目或匹配的环境变量覆盖）必须包含 `permission_control: codex`；顶层 `provider_options` 不会继承。空 selector 条目或空 `provider_options` 条目会在加载配置时被拒绝。dynamic parallel 和 `dynamic_facets` selector 使用 provider-neutral 的新 session，并传入固定的只读工具 allowlist `Read`、`Glob`、`Grep` 以及 `permission_mode: readonly`。Companion selector 不接收固定的 `allowedTools` 列表，因此可以使用 selector profile 中的 `allowed_tools`。工具 allowlist 只对遵守它的 provider 生效。没有 dynamic parallel、dynamic facets 或启用的 companion pool 时，selector 设置不会使用，也不会影响 workflow。

```yaml
# ~/.takt/config.yaml（续）

# Workflow 安全策略（默认全部拒绝）
# 控制不受信任的 workflow YAML 可以执行什么。
# workflow_mcp_servers:                  # MCP server transport 策略
#   stdio: true                          # 允许 stdio transport（默认 false）
#   sse: false                           # 允许 SSE transport（默认 false）
#   http: false                          # 允许 HTTP transport（默认 false）
# workflow_arpeggio:                     # Arpeggio 自定义代码策略
#   custom_data_source_modules: false    # 允许自定义 data source module（默认 false）
#   custom_merge_inline_js: false        # 允许内联 JS merge 函数（默认 false）
#   custom_merge_files: false            # 允许外部 merge 文件（默认 false）
# workflow_runtime_prepare:              # Runtime prepare 策略
#   custom_scripts: false                # 允许自定义脚本（默认 false；builtin preset 始终允许）
# workflow_command_gates:                # Workflow YAML command quality gate 策略
#   custom_scripts: false                # 允许来自 workflow YAML 的 command gate（默认 false）
# sync_conflict_resolver:                # Sync conflict resolver 策略
#   auto_approve_tools: false            # 允许工具自动批准（默认 false）

# Builtin workflow 过滤（可选；配置 key 保持 workflow_* 名称）
# enable_builtin_workflows: true         # 设为 false 禁用所有 builtin workflow
# disabled_builtins: [magi]              # 按名称禁用指定 builtin workflow

# Pipeline 执行配置（可选）
# 自定义分支名、commit message 和 PR body。
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}

# 路由决策 telemetry 仅保存到本地。
# telemetry:
#   routing_decisions: true       # 写入 .takt/events/（默认 false；可用 takt telemetry enable 或此 key 启用）
```

`language` 目前只接受 `en` 和 `ja`。本页的 `.zh-CN.md` 是文档 locale，不会新增运行时 UI 或 prompt 的中文支持。

### 全局配置字段参考

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI 语言 |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | 日志级别 |
| `logging.trace` | boolean | `false` | 启用 trace 级日志 |
| `logging.debug` | boolean | `false` | 启用 debug 日志（`debug.log` + `prompts.jsonl`） |
| `logging.provider_events` | boolean | `false` | 持久化 provider stream event |
| `logging.usage_events` | boolean | `false` | 持久化 usage event 日志 |
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-headless"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude-sdk"` | 默认 AI provider（`claude` 是 `claude-sdk` 的别名，`claude-headless` 使用 headless CLI）；`deepseek-harness` 是官方 DeepSeek Harness TypeScript SDK/runtime `0.2.1-alpha.2` |
| `model` | string | - | 默认 model 名称，原样传给 provider |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | 分支名生成策略 |
| `prevent_sleep` | boolean | `false` | 阻止 macOS 空闲睡眠 |
| `notification_sound` | boolean | `true` | 启用通知音 |
| `notification_sound_events` | object | - | 各事件通知音开关 |
| `concurrency` | number (1-10) | `1` | `takt run` / `takt watch` 并行任务数 |
| `task_poll_interval_ms` | number (100-5000) | `500` | 新任务轮询间隔 (`takt run` / `takt watch`) |
| `interactive_preview_steps` | number (0-10) | `3` | 交互模式中的 step 预览数 |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` \| object | mode `"y/N"`，comments `true` | 添加 Alloy/Quint 指导，要求同时用两种记法表达。object 格式可独立设置 `mode`、`comments` 和 `model_check_timeout_seconds`；`comments: false` 仅移除自然语言含义注释指令，不减少形式规格数量、需求覆盖、语法或正确性指令。`model_check_timeout_seconds` 是 `/verify` 中 `quint verify` 与 Alloy Analyzer 的上限秒数（1～86,400 的整数，默认 900），`parse`/`typecheck`/`run` 的 60 秒不变。project 和 global 的 object 字段独立解析，project 优先。`true` 和 `false` 不提问；TTY 下 `"Y/n"`、`"y/N"` 每个会话提问一次并分别以 Yes、No 为默认值；非 TTY 不读取标准输入，直接采用默认答案。Gherkin 指导仅适用于开发和实现任务。 |
| `auto_requeue_max_attempts` | 非负整数 | `0` | 失败 workflow task 的自动 requeue 上限；`0` 禁用 (`takt run` / `takt watch`) |
| `ignore_exceed` | boolean | `false` | 配置 `takt run` 和 `takt watch` 的迭代上限绕过 |
| `sync_project_local_takt_on_retry` | boolean | `true` | retry/re-execution 前将根项目 `.takt` 同步到 worktree |
| `worktree_dir` | string | - | shared clone 目录，默认 `../{clone-name}` |
| `allow_git_hooks` | boolean | `false` | 允许 TAKT 管理的自动 commit 运行 git hooks |
| `allow_git_filters` | boolean | `false` | 允许 TAKT 管理的自动 commit 运行 git filters |
| `auto_pr` | boolean | - | worktree 执行后自动创建 PR |
| `caccia` | object | `{ enabled: false, wait_timeout_ms: 1800000, max_iterations: 3, workflow: "caccia" }` | CodeRabbit 审查循环设置 |
| `draft_pr` | boolean | `false` | 将自动创建的 PR 设为 draft |
| `minimal_output` | boolean | `false` | 抑制 AI 输出（用于 CI） |
| `runtime` | object | - | 运行环境默认值，例如 `prepare: [gradle, node]` |
| `provider_routing` | object | - | 按 raw persona、step tag 和 step 名称设置 provider/model/options 路由 |
| `auto_routing` | object | - | 从 candidate pool 自动选择 provider/model |
| `persona_providers` | object | - | 已弃用的按显示名称覆盖；新配置请使用 `provider_routing` |
| `provider_options` | object | - | 全局 provider 专属选项 |
| `provider_profiles` | object | - | provider 专属权限 profile |
| `rate_limit_fallback` | object | - | 限流 fallback；`switch_chain` 按顺序列出切换到的 `{provider, model}` |
| `anthropic_api_key` | string | - | Claude 的 Anthropic API key |
| `openai_api_key` | string | - | Codex 的 OpenAI API key |
| `gemini_api_key` | string | - | Gemini API key |
| `google_api_key` | string | - | Google API key |
| `groq_api_key` | string | - | Groq API key |
| `openrouter_api_key` | string | - | OpenRouter API key |
| `opencode_api_key` | string | - | OpenCode API key |
| `cursor_api_key` | string | - | Cursor API key（可选；支持登录 session） |
| `copilot_github_token` | string | - | Copilot CLI 认证所需 GitHub token |
| `kiro_api_key` | string | - | Kiro API key |
| `codex_cli_path` | string | - | Codex CLI 绝对路径覆盖 |
| `claude_cli_path` | string | - | Claude Code CLI 绝对路径覆盖 |
| `cursor_cli_path` | string | - | Cursor Agent CLI 绝对路径覆盖 |
| `copilot_cli_path` | string | - | Copilot CLI 绝对路径覆盖 |
| `kiro_cli_path` | string | - | Kiro CLI 绝对路径覆盖 |
| `enable_builtin_workflows` | boolean | `true` | 是否启用 builtin workflow |
| `disabled_builtins` | string[] | `[]` | 按 workflow `name` 禁用 builtin workflow |
| `pipeline` | object | - | Pipeline 模板设置 |
| `bookmarks_file` | string | - | bookmarks 文件路径 |
| `auto_fetch` | boolean | `false` | 创建 clone 前 fetch remote |
| `base_branch` | string | - | 创建 clone 的基分支，默认 remote 默认分支 |
| `workflow_categories_file` | string | - | 分类文件路径，默认 overlay 使用 `workflow-categories.yaml` |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自动检测 | VCS provider |
| `takt_providers` | object | - | TAKT 内部 provider 覆盖（`assistant` 也作为 Report fallback provider） |
| `telemetry` | object | `{ routing_decisions: false }` | 仅本地的路由决策记录，默认关闭 |
| `analytics` | object | disabled | 仅本地的 analytics 收集 |
| `workflow_mcp_servers` | object | 全部 `false` | MCP server transport 策略 |
| `workflow_arpeggio` | object | 全部 `false` | Arpeggio 自定义代码策略 |
| `workflow_runtime_prepare` | object | `{ custom_scripts: false }` | Runtime prepare 策略 |
| `workflow_command_gates` | object | `{ custom_scripts: false }` | Workflow YAML command quality gate 策略 |
| `workflow_overrides` | object | - | workflow 级 `quality_gates` 与 `quality_gates_edit_only` 覆盖 |
| `sync_conflict_resolver` | object | `{ auto_approve_tools: false }` | sync conflict resolver 策略 |
| `observability` | object | disabled | opt-in OpenTelemetry 基础设施 |

## Caccia Review Loop

`caccia` 可以设置在 `~/.takt/config.yaml` 或 `.takt/config.yaml` 中：

```yaml
caccia:
  enabled: false          # 任务创建或更新 PR 后启用自动关联
  wait_timeout_ms: 1800000 # 等待初次审查和每次推送提交审查的上限（毫秒）
  max_iterations: 3       # 修复和复审的最大轮数
  workflow: caccia        # 用于判断和修复每组线程的 workflow
```

只有 `enabled: true` 时才运行自动关联。无论该开关为何值，都可以手动运行 `takt caccia <PR-number>`。默认值为关闭、1,800,000 毫秒、3 轮和 workflow `caccia`。如果项目中存在 `caccia` 配置块，它整体优先于全局块；所选配置块中省略的字段使用上述默认值。将 `workflow` 设置为 workflow 标识符即可替换 builtin workflow。

`wait_timeout_ms` 同时适用于初次审查检查和每次推送提交后的复审等待。初次等待超时会跳过 Caccia；单独命令以非零状态退出，自动关联路径会跳过并保留任务结果。等待推送提交的复审超时则属于执行错误：单独命令以非零状态退出，自动关联路径会记录错误并保留已完成的任务结果。

自动关联的进度、workflow 输出、结果和失败信息继承父任务的显示模式和任务名前缀。silent 模式的父任务不会产生 Caccia 屏幕输出。

## 项目配置

在 `.takt/config.yaml` 中设置项目专属配置。第一次在项目目录使用 TAKT 时会创建该文件。

```yaml
# .takt/config.yaml
provider: claude-sdk              # 覆盖项目的 provider
model: sonnet                 # 覆盖项目的 model
auto_pr: true                 # worktree 执行后自动创建 PR
concurrency: 2                # 此项目 takt run / takt watch 的并行任务数（1-10）
auto_requeue_max_attempts: 1  # takt run / takt watch 期间失败 workflow task 的自动 requeue 次数
ignore_exceed: false          # 对 takt run 和 takt watch 应用 --ignore-exceed
# base_branch: main           # 创建 clone 的基分支（覆盖全局值，默认 remote 默认分支）

# 项目专属的 assistant 设置
# assistant:
#   formal_spec:
#     mode: 'Y/n'               # 仅覆盖全局 Alloy/Quint 模式
#     comments: false           # 保留形式规格，仅移除含义注释的强制指令
#   init_files:
#     # 仅项目配置支持；交互 assistant 的初始上下文文件
#     - docs/assistant-context.md
#     - .takt/assistant-notes.md

# provider 专属选项（旧版项目默认值；runtime.yaml 的 profile 现在拥有这些选项）
# codex / claude / claude_terminal / cursor / copilot / kiro / pi 也支持
#   guards.call_timeout_ms（未设置时为 60 分钟）。
# provider_options:
#   codex:
#     network_access: true
#   opencode:
#     variant: high
#     allowed_tools: [read, glob, grep, bash, websearch, webfetch]
#     guards:
#       profile: standard
#       model_profiles:
#         "opencode/big-pickle": minimal
#         "lmstudio/*": standard
#       call_timeout_ms: 3600000
#       event_limit: 500000
#       text_byte_limit: 1048576
#       reasoning_byte_limit: 4194304
#   kiro:
#     agent: my-default-agent
#   pi:
#     extensions: [npm:pi-fff]
#     no_skills: true
#   deepseek_harness:
#     base_url: http://127.0.0.1:8787/v1
#     max_tokens: 4096
#     request_timeout_ms: 3600000
#     shutdown_timeout_ms: 1000
# #   claude_terminal:
#     backend: tmux
#     timeout_ms: 900000
#     keep_session: false
#     transcript_poll_interval_ms: 500

# provider 专属权限 profile（项目级覆盖）
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly
```

项目配置在同时设置时覆盖全局配置。项目 schema 是严格的：`logging`、`disabled_builtins`、`enable_builtin_workflows`、通知设置、API key 和 CLI 路径等全局专属 key 写入 `.takt/config.yaml` 会在启动时触发配置验证错误。Provider credential 应通过环境变量或全局 `~/.takt/config.yaml` 配置。

### Pi provider session 边界

TAKT 的 Pi provider 在当前 TAKT 进程中使用嵌入式、内存中的 Pi SDK session。它不会写 Pi session JSONL，也不会读写 Pi CLI 全局 `settings.json`。因此 Pi 全局的默认 model、thinking level、shell 和 retry 选项不会自动继承到 TAKT。

在同一进程和工作目录中复用已缓存的 session 时，改变显式 extension 或资源加载设置仍会保留逻辑 session ID 和对话历史。SessionManager 是历史的权威来源；TAKT 等待前一个 turn 结束和旧 runtime 的 shutdown 完成后，才替换 SDK runtime。每个 turn 都会应用 model、thinking level 和工具权限。

如果 shutdown 成功后新 runtime 初始化失败，对话历史仍会保留，供后续重建使用；已释放的 runtime 不会被复用。如果 shutdown 本身失败，则阻止替换以及该逻辑 session 的后续调用。

TAKT 在普通和嵌套工具执行之前检查 Pi 工具权限。空或仅含空白的 allowlist 拒绝所有工具。来源验证失败会禁用工具并中止执行；改变同一逻辑 session 的 extension 配置不能清除失败状态。标准 TAKT loader 默认加载 Pi SDK 的 `codemode` extension，并在 `readonly`、`edit`、`full` 模式中启用，但不会增加底层工具权限。JavaScript 可以调用多个工具，并只返回选定的结果：

```js
const [matches, files] = await Promise.all([
  tools.grep({ pattern: "createPiResourceLoader", path: "src" }),
  tools.find({ pattern: "*.test.ts", path: "src/__tests__" }),
]);
return matches;
```

每个嵌套调用仍由相同的 permission mode 和显式 `allowedTools` 列表检查；被拒绝的调用会在工具运行前失败。显式 allowlist 不含 `codemode` 时，codemode 仍保持 inactive。不会开放额外的 codemode `models` API；MCP 和 tool search 仍需显式启用。这些检查不提供操作系统 sandbox 或逐工具确认提示。

需要将 Pi 设为默认值时，请在 TAKT 配置中显式指定 model。model 选择和 thinking level 选择应分开配置。在旧版 `config.yaml` 模式下，推荐使用显式 option：

```yaml
# ~/.takt/config.yaml 或 .takt/config.yaml
provider: pi
model: provider/model
provider_options:
  pi:
    thinking_level: high
```

runtime 模式下，将 `thinking_level` 放在 Pi profile 的 `provider.profiles.<name>.options` 中。workflow YAML 不能定义 provider、model 或 provider options。

Pi 的 thinking level 只能通过 `provider_options.pi.thinking_level` 或 `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL` 设置。可接受的值为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 和 `max`；无效值会直接失败。省略该选项时使用 Pi SDK 默认值 `medium`。model reference 只按 `/` 分割，因此 model ID 中的 `:` 会原样保留；例如 `provider/model:high` 的 model ID 是 `model:high`。显式设置的 level 会在每个 Pi turn 之前应用，包括复用 session 的 turn。

如果旧配置曾使用 `model: pi/...:high` 末尾形式来指定 thinking level，请从 model reference 中删除 `:high`，改为设置以下 option：

```yaml
provider_options:
  pi:
    thinking_level: high
```

`provider` 和 `model` 声明选择 TAKT run 的 provider 和 model；显式 Pi option 选择 thinking level。它们不会导入 Pi CLI 设置。Pi 认证由 Pi SDK credential store 或 provider 原生环境变量单独处理。这样可以避免意外写入全局设置，并使项目本地配置保持可信且可预测。

`provider_options.pi` 同时包含独立的 `thinking_level` option，以及用于加载 Pi 资源的 `extensions` 和 `no_*` discovery 控制。它不负责 authentication 或 model 选择。没有版本限定的显式 npm source 会依次复用已有的 project scope、user scope，只有两者都无法成功加载时才使用 temporary resolution；带版本的 npm source 和非 npm source 始终使用 temporary resolution。显式资源不会写入 Pi 设置。

### Provider inactivity deadline 与 OpenCode execution guard

所有 provider 都使用 `guards.call_timeout_ms` 作为没有可观察 provider event 时允许的最长时间。每个 stream/tool event、阶段完成和新的 provider attempt 都会重置计时器；累计执行时间没有上限。它适用于 `codex`、`opencode`、`claude`（由 `claude-sdk`、别名 `claude` 和 `claude-headless` 共享）、`claude_terminal`、`cursor`、`copilot`、`kiro` 和 `pi`。取值是 60,000 到 86,400,000 之间的整数毫秒，默认 3,600,000 ms（60 分钟）。通常的 `provider_options` profile 解析路径会将该值应用到 engine 的 parent-step deadline，并向所有 provider 传递同一个 `AbortSignal`。`claude_terminal.timeout_ms` 为兼容性保留，仅在未设置 `guards.call_timeout_ms` 时使用。

`provider_options.opencode.guards.profile` 默认是 `standard`。`minimal` 只关闭启发式循环检测；时间、资源上限、完整性和严格修正 guard 仍然强制启用。`model_profiles` 按解析出的 model 字符串以声明顺序选择 profile，唯一通配符是 `*`。guard leaf 在 provider-option 层之间独立合并；较高优先级的 `model_profiles` 值会替换较低优先级的完整 map。

每次 OpenCode 调用都有 3,600,000 ms 的 provider-event 不活跃上限。只要持续收到 event，健康调用可以超过该时间。`event_limit` 默认 500,000，可由 `TAKT_OPENCODE_STREAM_EVENT_LIMIT` 覆盖；`text_byte_limit` 默认 1 MiB，`reasoning_byte_limit` 默认 4 MiB。

TAKT 观察实际收到的 provider event，不会合成 keepalive。OpenCode 从 tool-start event 到终止 event 的期间视为 in-flight，并暂停普通不活跃检查；若终止 event 缺失或完全挂起，in-flight 状态在 `call_timeout_ms` 的六倍后过期并以 `PART_TIMEOUT` 结束。`guards.*` 下的无效数值（包括通过 `TAKT_PROVIDER_OPTIONS_*` 设置的值）属于声明式配置，如果不是有效的正整数则会快速失败并报错；实验性 `TAKT_OPENCODE_*` 覆盖中的无效值会被忽略并使用默认值。旧的 `TAKT_OPENCODE_TOOL_ERROR_BUDGET`、`TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE`、`TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS`、`TAKT_OPENCODE_TOOL_SUCCESS_REPEATS` 和 `TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS` 不再控制 guard，会被忽略并发出一次性警告。

### 项目配置字段参考

项目配置接受大多数全局 key 并覆盖全局值，例如 `language`、`branch_name_strategy`、`minimal_output`、`task_poll_interval_ms`、`interactive_preview_steps`、`provider_routing`、`persona_providers`、`runtime`、`analytics`、`telemetry`、`rate_limit_fallback` 和 `workflow_overrides`。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | provider 名称联合 | - | 覆盖具体 provider |
| `model` | string | - | 覆盖 model 名称 |
| `submodules` | `"all"` \| string[] | - | shared clone 中要初始化的 submodule |
| `with_submodules` | boolean | - | `submodules: "all"` 的旧版布尔形式 |
| `allow_git_hooks` | boolean | `false` | 自动 commit 时允许 git hooks |
| `allow_git_filters` | boolean | `false` | 自动 commit 时允许 git filters |
| `auto_pr` | boolean | - | worktree 执行后自动创建 PR |
| `caccia` | object | disabled | CodeRabbit 审查循环设置（见上文） |
| `draft_pr` | boolean | `false`（来自全局） | 将自动创建的 PR 设为 draft |
| `concurrency` | number (1-10) | `1`（来自全局） | `takt run` / `takt watch` 并行任务数 |
| `auto_requeue_max_attempts` | 非负整数 | `0` | 失败 workflow task 的自动 requeue 上限 (`takt run` / `takt watch`) |
| `ignore_exceed` | boolean | `false` | `takt run` / `takt watch` 的迭代限制绕过 |
| `base_branch` | string | - | 创建 clone 的基分支 |
| `assistant.init_files` | string[] | - | 仅项目级的 assistant 初始上下文文件。路径必须相对于项目根；绝对路径、解析到项目根之外的路径，以及 `.env*`、`.npmrc`、`.pypirc`、`.netrc`、`*.pem`、`*.key` 和 `.git/**` 等敏感文件模式会被拒绝。路径不存在、指向目录或文件不可读时会明确报错。最多 16 个文件，每个最多 256 KiB，合计最多 1 MiB。未设置或为空时，TAKT 不会自动发现 `CLAUDE.md`、`AGENT.md`、`AGENTS.md`、`TAKT.md` 或其他文件。 |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` \| object | mode `"y/N"`，comments `true`（来自全局/默认值） | 项目级覆盖，添加 Alloy/Quint 指导并要求同时用两种记法表达。object 格式可独立设置 `mode`、`comments` 和 `model_check_timeout_seconds`，未设置的字段回退到全局或默认值。`comments: false` 仅移除自然语言含义注释指令，不减少形式规格数量、需求覆盖、语法或正确性指令。项目值优先于全局值。提示回答仅在当前会话中生效，恢复会话时重新解析。ACP 和非 TTY 不提问，使用配置的默认答案。Gherkin 指导仅适用于开发和实现任务。已弃用的 `assistant.gherkin` 会警告后忽略，不转换、不持久化，也不修改配置文件。 |
| `provider_options` | object | - | provider 专属选项 |
| `provider_profiles` | object | - | provider 专属权限 profile |
| `vcs_provider` | `"github"` \| `"gitlab"` | 自动检测 | 覆盖全局 VCS provider |
| `takt_providers` | object | - | TAKT 内部 provider 覆盖 |
| `workflow_mcp_servers` | object | - | MCP transport 策略覆盖 |
| `workflow_arpeggio` | object | - | Arpeggio 自定义代码策略覆盖 |
| `workflow_runtime_prepare` | object | - | Runtime prepare 策略覆盖 |
| `workflow_command_gates` | object | - | Workflow YAML command quality gate 策略覆盖 |
| `sync_conflict_resolver` | object | - | Sync conflict resolver 策略覆盖 |
| `observability` | object | - | 项目级 OpenTelemetry opt-in 覆盖 |

### 任务执行配置的环境变量覆盖

`auto_requeue_max_attempts` 和 `ignore_exceed` 也可以使用 `TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` 和 `TAKT_IGNORE_EXCEED` 设置。解析顺序为：

1. 环境变量
2. 项目 `.takt/config.yaml`
3. 全局 `~/.takt/config.yaml`
4. 默认值

`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` 必须解析为非负整数；非数字、负数和非整数会使配置验证失败。`TAKT_IGNORE_EXCEED` 只接受 `true` 或 `false`。

## 环境变量覆盖

大多数配置 key 都可以通过 `TAKT_` 加上大写、下划线连接的 key 路径覆盖：`logging.debug` 变成 `TAKT_LOGGING_DEBUG`，`telemetry.routing_decisions` 变成 `TAKT_TELEMETRY_ROUTING_DECISIONS`。常见例子包括 `TAKT_PROVIDER`、`TAKT_MODEL`、`TAKT_CONCURRENCY`、`TAKT_LOGGING_DEBUG`、`TAKT_TELEMETRY_ROUTING_DECISIONS` 和 `TAKT_OBSERVABILITY_ENABLED`。环境变量优先于对应文件值，并在拥有该 key 的配置层解析。

除了配置 key 覆盖外，`TAKT_NOTIFY_WEBHOOK` 设置 Slack Incoming Webhook URL。设置后，TAKT 会在 pipeline 完成和 `takt run` 任务批次结束时发送 Slack 通知。

## API Key 配置

TAKT 支持 Claude、Codex、OpenCode、Pi、官方 DeepSeek Harness SDK、Cursor、Copilot 和 Kiro provider。Claude/Codex/OpenCode 使用各自 SDK credential，Pi 使用 Pi SDK credential store 或 provider 原生环境变量，DeepSeek Harness 先通过 `takt install deepseek-harness` 安装 TypeScript SDK/runtime，再通过官方 credential store（`$DSH_HOME/.credentials.yaml`，默认 `~/.dsh/.credentials.yaml`）或 `DEEPSEEK_API_KEY` 认证，Cursor 支持 API key 或已有 `cursor-agent login` session，Copilot 使用 GitHub token，Kiro 使用 API key。

全局配置 schema 还保留了一些当前不能作为顶层 provider 选择的 legacy 或 provider integration API key 字段。这些字段本身不会启用 provider；请根据所选 provider，使用下文记录的认证环境变量或配置 key。

### 环境变量（推荐）

```bash
# Claude（Anthropic）
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode
export TAKT_OPENCODE_API_KEY=...

# Pi
# 使用 Pi SDK credential store 或 provider 原生环境变量

# 官方 DeepSeek Harness TypeScript SDK
export DEEPSEEK_API_KEY=...  # 使用保存的 credential 时可省略
# 可选：export DEEPSEEK_BASE_URL=https://...

# Cursor Agent（如果已有 cursor-agent login session，则可选）
export TAKT_CURSOR_API_KEY=...

# GitHub Copilot CLI
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...

# Kiro CLI（当 TAKT_KIRO_API_KEY 和 kiro_api_key 未设置时，也接受 KIRO_API_KEY）
export TAKT_KIRO_API_KEY=...
```

### 配置文件

```yaml
# ~/.takt/config.yaml
anthropic_api_key: sk-ant-...  # Claude
openai_api_key: sk-...         # Codex
opencode_api_key: ...          # OpenCode
cursor_api_key: ...            # Cursor Agent（可选）
copilot_github_token: ghp_...  # GitHub Copilot CLI
kiro_api_key: ...              # Kiro CLI
```

### 优先级

环境变量优先于 `config.yaml`。

| Provider | 环境变量 | 配置 key |
|----------|----------|----------|
| Claude（Anthropic） | `TAKT_ANTHROPIC_API_KEY` | `anthropic_api_key` |
| Codex（OpenAI） | `TAKT_OPENAI_API_KEY` | `openai_api_key` |
| OpenCode | `TAKT_OPENCODE_API_KEY` | `opencode_api_key` |
| Pi | Pi SDK credential store 或 provider 原生环境变量 | - |
| DeepSeek Harness | 官方 store `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）或 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`） | - |
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |
| Kiro CLI | `TAKT_KIRO_API_KEY`（`KIRO_API_KEY` fallback） | `kiro_api_key` |

如果将 API key 写入配置文件，请勿将该文件 commit 到 Git；更推荐环境变量，并可将 `~/.takt/config.yaml` 加入全局 `.gitignore`。

### 安全

TAKT 不读取、复制或改写保存的 DeepSeek credential 值。DeepSeek Harness TypeScript SDK/runtime 支持 glibc >= 2.28 的 Linux x64/arm64 和 macOS arm64 >= 14.0。Cursor 已有 `cursor-agent login` session 时可以不设置 API key；Copilot 和 Kiro 仍需各自的 CLI。

### CLI 路径覆盖

```bash
export TAKT_CLAUDE_CLI_PATH=/usr/local/bin/claude
export TAKT_CODEX_CLI_PATH=/usr/local/bin/codex
export TAKT_CURSOR_CLI_PATH=/usr/local/bin/cursor-agent
export TAKT_COPILOT_CLI_PATH=/usr/local/bin/github-copilot-cli
export TAKT_KIRO_CLI_PATH=/usr/local/bin/kiro-cli
```

```yaml
# ~/.takt/config.yaml
claude_cli_path: /usr/local/bin/claude
codex_cli_path: /usr/local/bin/codex
cursor_cli_path: /usr/local/bin/cursor-agent
copilot_cli_path: /usr/local/bin/github-copilot-cli
kiro_cli_path: /usr/local/bin/kiro-cli
```

路径必须是可执行文件的绝对路径。CLI 路径覆盖只属于全局配置，不要写入项目 `.takt/config.yaml`。

## Model 解析

启用 runtime 模式时，provider 和 model 由 `runtime.yaml` 管理，同时仍可使用 CLI 和环境变量覆盖。旧版模式继续支持 `config.yaml` 中的 provider、model 和 routing 设置。workflow YAML 不能选择 provider 或 model；其中的 `provider`、`model` 和内联 provider options 会在加载边界失败并给出迁移提示。

### Provider 专属 model 说明

- **Claude Code** 支持 `opus`、`sonnet`、`haiku`、`opusplan`、`default` 等别名和完整 model 名称；`claude-sdk` 及其别名 `claude` 通过 Agent SDK 的 model option 传递 `model`；`claude-headless` 和 `claude-terminal` 通过 CLI 的 `--model` 参数传递。可用 model 参见 [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)。
- **Codex** 通过 Codex SDK 原样使用 model 字符串；省略时默认 `codex`。
- **OpenCode** 显式指定的 model 必须使用 `provider/model` 格式，例如 `opencode/big-pickle`。workflow 通常要求显式指定 model。只有当解析过程丢弃了一个归属 provider 与所选 OpenCode provider 不同的 model 时，才允许 model 为空并由所选 OpenCode runtime 解析默认 model。workflow 之外的配置仍要求显式指定 model。
- **Pi** 接受 `provider/model` 引用或能唯一匹配 Pi model 的裸 ID。reference 只按 `/` 分割，因此 `provider/model:high` 中的 `model:high` 是字面 model ID。thinking level 通过 `provider_options.pi.thinking_level` 或 `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL` 设置；省略时使用 Pi SDK 默认值 `medium`。显式设置的 level 会应用于每个 Pi turn。省略 model 时，TAKT 保留 Pi session 当前的 model。
- **Cursor Agent** 将 model 原样传给 `cursor-agent --model <model>`。
- **GitHub Copilot CLI** 将 model 原样传给 `copilot --model <model>`。
- **Kiro CLI** 将 model 原样传给 `kiro-cli chat --model <model>`。

### 示例

```yaml
# ~/.takt/config.yaml
provider: claude-sdk
model: opus     # 所有 step 的默认 model（除非被覆盖）
```

workflow 的 `promotion` 只能推进 `runtime.yaml` 选择的 target ladder，不能包含 provider、model、provider-options 或 condition 字段。workflow 中用 `capabilities` 请求工具、网络、sandbox 或 skill 能力，但不选择 runtime。

## Runtime Provider 配置（`runtime.yaml`）

`runtime.yaml` 将 provider/model/options 从 workflow 中移出，使同一 workflow 可以在不同执行环境中运行而无需修改。固定读取两个路径，项目文件优先：

1. `~/.takt/runtime.yaml`
2. `<project>/.takt/runtime.yaml`

Companion reviewer 默认禁用。使用顶层 `companion.enabled` 策略启用：

```yaml
version: 1
companion:
  enabled: true
  review_mode: completion # completion | live
```

`companion` 策略至少要指定 `enabled` 或 `review_mode` 之一。像
`companion: { review_mode: live }` 这样的仅指定 mode 的策略会被接受，并解析为
`enabled: false`；空的 `companion: {}` 会被拒绝。

全局与项目策略同时设置时使用逻辑 AND；项目的 `true` 不能重新启用全局禁用的 companion。省略的策略在层合并时是 neutral；两层都没有设置时 Companion 仍禁用。Companion target 和 provider capability 只在启用时解析/执行；禁用时仍会校验 companion 声明和 `targets.companions` 的结构，但不会解析或运行 companion provider。只有存在有效 `provider` section 时才启用 runtime 模式；只有 `version: 1` 的文件不会改变旧版 `config.yaml` provider 解析。

`companion.review_mode` 默认是 `completion`。project 值优先于 global 值；project 未指定时继承 global 值。`completion` 在 implementer 成功响应后审查累计 diff，`live` 保留响应期间的 quiet、forced 和 commit 触发。只接受 `completion` 和 `live`；无效值会在加载 `runtime.yaml` 时失败。即使 `companion.enabled` 为 `false`，仍会验证 mode 的结构，但不会解析或执行 Companion provider。

### 配置示例

```yaml
version: 1

provider:
  defaults:
    profile: sol-medium

  profiles:
    sol-high:
      provider: codex
      model: gpt-5.6-sol
      options:
        reasoning_effort: high
    sol-medium:
      provider: codex
      model: gpt-5.6-sol
      options:
        reasoning_effort: medium
    sol-low:
      provider: codex
      model: gpt-5.6-sol
      options:
        reasoning_effort: low
    router:
      provider: codex
      model: gpt-5.6-luna
      capabilities: readonly
      permission_mode: readonly
      options:
        reasoning_effort: high

  targets:
    personas:
      coder:
        profile: sol-medium
    tags:
      high-stakes:
        profile: sol-high
    steps:
      default/supervise:
        profile: sol-high
      default/implement:
        pool: sol-pool
    internal_agents:
      selector:
        profile: router
      review-completion-judge:
        profile: router

  auto_routing:
    strategy: balanced
    router_profile: router
    pools:
      sol-pool:
        candidates:
          - profile: sol-high
            tier: high
          - profile: sol-medium
            tier: medium
          - profile: sol-low
            tier: low
        fallback_profile: sol-high
```

### 命名 assignment

`provider.assignments` 用于定义通过项目目录或 `--runtime-assignment <name>` 选择的命名 provider 配置集合。每个 entry 必须至少包含
`defaults` 或 `targets`，不能使用空 assignment。`defaults` 与顶层 `provider.defaults` 形状完全相同，必须
在 `profile` 和 `ladder` 中选择一个。`targets` 与顶层 `provider.targets` 形状相同：`personas`、`tags`、
`steps` 可以使用 `profile`、`pool` 或 `ladder`，`internal_agents` 只能使用 `profile` 或 `ladder`，
而 `companions` 只能使用固定的 `profile`。

`provider.directories` 将目录路径映射到 assignment 名称。匹配对象是启动时的 project 目录。路径键会先展开
`~`、转换为绝对路径，并对存在的路径进行 realpath 等价的规范化，然后进行完全匹配；不支持前缀匹配和 glob。
如果目录值引用了未定义的 assignment，加载时会快速失败。目录匹配成功后使用 assignment 的 `defaults`；如果
省略，则回退到顶层 `provider.defaults`。如果 assignment 提供了 `targets`，它会整体替换顶层
`provider.targets`，不会按 `personas` 等子 map 合并。省略 `targets` 的 assignment 会继续使用顶层
`provider.targets`。`profiles` 和 `auto_routing` 继续共享。

```yaml
provider:
  assignments:
    project-sol:
      defaults:
        profile: sol-medium
      targets:
        personas:
          coder:
            profile: sol-medium
        steps:
          default/implement:
            pool: sol-pool

  directories:
    ~/work/example: project-sol
```

global 与 project 层之间，`assignments` 遵循与 profile 相同的规则：同名 entry 由 project 整体替换，不同名称
的 entry 共存。`directories` 在规范化后的键相同时由 project 优先，不同路径则共存。上述合并发生在目录
assignment 选择之前。assignment 内的 profile、pool、ladder 引用与其他 runtime provider 引用一样会被校验，
并在 agent 运行前快速失败。

#### 启动时选择预设

`--runtime-assignment <name>` 从 global 和 project runtime.yaml 合并后的 `provider.assignments`
中选择名称，优先于匹配的 `provider.directories`。assignment 只应用一次，以合并后的顶层配置为基准：
省略 `defaults` 或 `targets` 时继承顶层值；提供 `targets` 时整体替换 map。
`profiles`、`auto_routing`、`mcp`、`companion` 和 `loop_analysis` 保持共享。
现有 `--provider`、`--model` 和 `--auto-strategy` override 仍优先于选择后的配置。

在共享的项目 `.takt/runtime.yaml` 中定义 profile 和成本优先、质量优先的预设：

```yaml
version: 1
provider:
  profiles:
    sol-high: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: high } }
    sol-medium: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: medium } }
    sol-low: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: low } }
  defaults: { profile: sol-medium }
  targets:
    personas:
      reviewer: { profile: sol-high }
  assignments:
    cost:
      defaults: { profile: sol-low }
      targets:
        personas:
          reviewer: { profile: sol-medium }
    quality:
      defaults: { profile: sol-high }
```

```sh
takt --runtime-assignment cost "#123"
takt run --runtime-assignment quality
takt --pipeline --runtime-assignment cost "#123"
```

此例中，`cost` 默认使用 low 推理设置，reviewer 使用 medium；`quality` 默认使用 high，
并继承顶层 reviewer target。

此选项适用于交互式启动、直接执行、pipeline、`run`、`watch` 和其他子命令。
同一次 `run` 的所有任务、同一 `watch` 启动后新增的任务、内部 agent 和 loop-analysis 使用相同选择。
选择操作不会改写配置文件，也不会保存到任务记录。requeue、retry 和 instruct 不会恢复过去启动的选择。
正常任务执行仍会更新任务状态。未指定选项时，原有目录匹配和顶层解析行为保持不变。

名称未定义、assignments 不存在或没有有效 runtime provider section 时，在任何 agent 启动前停止。
错误包含指定名称和可用 assignment 名称列表，或说明没有定义；不会回退到目录或 legacy 配置。

成员可在个人 `~/.takt/runtime.yaml` 中添加不同名称的 assignment，与项目预设一起选择：

```yaml
version: 1
provider:
  profiles:
    personal-model: { provider: codex, model: gpt-5.6-sol, options: { reasoning_effort: medium } }
  defaults: { profile: personal-model }
  assignments:
    personal:
      defaults: { profile: personal-model }
```

```sh
takt run --runtime-assignment personal
```

两层中不同名称的 profile 和 assignment 在合并后保留；同名 entry 由 project 整体替换。

`provider.profiles` 保存命名的 provider/model/options 定义。`provider.defaults` 必须在每个有效 provider section 中选择一个固定 `profile` 或有序 `ladder`；不能指定 `pool`。`provider.targets.personas`、`provider.targets.tags` 和 `provider.targets.steps` 可以选择固定 profile、有序 ladder 或显式 auto-routing pool；`internal_agents` 只能使用固定 profile 或 ladder；`companions` 必须使用固定 profile。

provider target 的覆盖优先级为：

```text
defaults
  < personas
  < tags
  < steps
```

同一优先级的两个目标如果指定了不同 provider，会快速失败而不是静默选择其一。显式 CLI `--provider` / `--model` 是 runtime override，在两种模式下都可用。`provider.auto_routing` 只对显式选择 `pool` 的 target 生效，不存在隐式 default pool。

### 解析优先级

workflow agent 的 provider 覆盖顺序为：

```text
defaults
  < personas
  < tags
  < steps
```

内部 `selector`、`assistant`、`loop-judge` 和 `review-completion-judge` 使用单独的顺序；未分配的 seat 使用普通默认解析：

```text
defaults
  < internal_agents.<agent>
```

`provider.auto_routing` 的 candidate 引用 `provider.profiles`，不重复 provider/model/options。只对显式配置 `pool` 的 workflow target 自动路由；没有显式 pool 的 target、workflow 外操作和辅助处理使用 `provider.defaults`。

### 从旧版 `config.yaml` 迁移

runtime 与旧版 provider 设置不能混用：

| 旧版设置 | Runtime 目标 |
|----------|--------------|
| `provider` / `model` | `provider.profiles` 中的 profile，并由 `provider.defaults` 引用 |
| `provider_options` | `provider.profiles.*.options` |
| `provider_routing.personas` | `provider.targets.personas` |
| `provider_routing.tags` | `provider.targets.tags` |
| `provider_routing.steps` | `provider.targets.steps` |
| `persona_providers` | `provider.targets.personas` |
| `takt_providers.selector` / `takt_providers.assistant` | `provider.targets.internal_agents` |
| `auto_routing` | `provider.auto_routing` |
| workflow 级 provider 设置 | `provider.targets.steps` |

### 混合配置错误

如果启用的 `runtime.yaml` provider section 与任意旧版 provider 设置共存，TAKT 会在 agent 运行前停止，并报告每个位置及对应迁移目标：

```text
检测到混合 provider 配置：启用的 runtime.yaml provider section 不能与旧版 provider 设置共存。
请移除 runtime.yaml provider section，或迁移以下旧版设置：
  - config.yaml:provider（global）→ provider.defaults + provider.profiles
  - config.yaml:provider_routing → provider.targets
```

### 首次生成

首次启动时，TAKT 会原子写入 `~/.takt/runtime.yaml`，不会覆盖已有文件，也不会自动生成项目 `.takt/runtime.yaml`。新环境会把选定的 provider/model 写入 `provider.profiles.default`，并设置 `provider.defaults.profile: default`。已有旧版 provider 设置的环境只会收到一个 inactive 的 `version: 1` 文件，因此迁移前行为不会改变。

## Provider Profile

Provider profile 可以为不同 provider 设置默认权限模式和按 step 的权限覆盖。

### 权限模式

| 模式 | 说明 | Claude | Codex | OpenCode | Pi | DeepSeek Harness | Cursor Agent | Copilot | Kiro CLI |
|------|------|--------|-------|----------|----|------------------|--------------|---------|----------|
| `readonly` | 只读，不修改文件 | `default` | `read-only` | `read-only` | `read`、`grep`、`find`、`ls`、`codemode` | 此 SDK 不提供 | 默认 flags（无 `--force`） | 无权限 flags | `--trust-tools=read,grep` |
| `edit` | 允许带确认的文件编辑 | `acceptEdits` | `workspace-write` | `workspace-write` | `read`、`grep`、`find`、`ls`、`edit`、`write`、`bash`、`codemode` | 此 SDK 不提供 | 默认 flags（无 `--force`） | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | 绕过所有权限检查 | `bypassPermissions` | `danger-full-access` | `danger-full-access` | 所有注册 Pi 工具 | 此 SDK 不提供 | `--force` | `--yolo` | `--trust-all-tools` |

Pi 的权限模式是 SDK active-tool allowlist，而不是操作系统 sandbox；TAKT 不为 Pi 增加逐工具确认。使用 Pi 时请确保 workflow 输入和 extension 可信。

### 配置

```yaml
# ~/.takt/config.yaml（全局）或 .takt/config.yaml（项目）
provider_profiles:
  codex:
    default_permission_mode: full
    step_permission_overrides:
      ai_review: readonly
  claude-sdk:
    default_permission_mode: edit
    step_permission_overrides:
      implement: full
```

### 权限解析优先级

权限解析顺序（先匹配者优先）：

1. 项目 `provider_profiles.<provider>.step_permission_overrides.<step>`
2. 全局 `provider_profiles.<provider>.step_permission_overrides.<step>`
3. 项目 `provider_profiles.<provider>.default_permission_mode`
4. 全局 `provider_profiles.<provider>.default_permission_mode`
5. step `required_permission_mode`（作为最低下限）

每个 provider 都有 builtin `default_permission_mode: edit`；如果项目和全局 profile 都没有设置，最终模式就是 `edit`，再根据 step 的 `required_permission_mode` 提高。

权限 profile 键必须与所选 provider 名称一致，键本身不作为别名处理。使用新的 `claude-sdk` 默认值或显式指定 `claude-sdk` 时，请将旧的 `provider_profiles.claude` 设置移到 `provider_profiles.claude-sdk`。显式指定 `claude` 仍使用 `claude` 键，`claude-headless` 使用 `claude-headless` 键。如果未指定 provider，旧 `claude` profile 中的 `readonly` 设置将不再生效，不迁移该 profile 可能导致 SDK 回退到 builtin `edit`。

## 旧版 `config.yaml` Provider Routing

runtime 模式未启用时，可以通过 `provider_routing` 将 workflow step 路由到不同 provider、model 和 provider options，而不复制 workflow。runtime 模式应使用 `provider.targets`。

```yaml
# ~/.takt/config.yaml
provider_routing:
  personas:
    coder:
      provider: codex
      model: gpt-5
      provider_options:
        codex:
          reasoning_effort: high
  tags:
    implementation:
      provider: codex
      model: gpt-5
    review:
      provider: opencode
      model: opencode/qwen3-coder-next
    final-gate:
      provider: codex
      model: gpt-5
      provider_options:
        codex:
          reasoning_effort: high
    edit:
      provider_options:
        codex:
          network_access: true
  steps:
    ai-antipattern-review-2nd:
      provider: opencode
      model: opencode/qwen3-coder-next
```

```yaml
# workflow.yaml
steps:
  - name: implement
    persona: coder
    persona_name: implementation-coder
    tags: [implementation, edit]
```

`provider_routing.personas` 使用 step 的原始 `persona` key；`persona_name` 只用于显示。`provider_routing.tags` 按 step 的 `tags` 匹配，多个 tag 按 step 中的书写顺序应用，后者覆盖相同 leaf。`provider_routing.steps` 使用 workflow step 的 `name`。每条 routing entry 至少包含 `provider`、`model` 或 `provider_options` 之一，空 `provider_options` 会被拒绝。

旧版 step 解析优先级：

```text
显式 CLI / 环境变量覆盖
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # 已弃用
> effective auto_routing
> project .takt/config.yaml
> global ~/.takt/config.yaml
> provider default
```

provider 按上述优先级选择。model 使用第一个指定了 model 的层。如果同一条配置也指定了 provider，只有该 provider 与最终选中的 provider 一致时才使用这个 model。不一致时，TAKT 不设置 model，也不会继续查找优先级更低的 model。没有指定 provider 的 model 会原样传递。workflow YAML 没有 provider/model 层；workflow promotion 只推进 runtime target ladder。

`persona_providers` 仍支持既有配置，但已弃用；它按 step 的 persona 显示名称匹配，该名称可能来自 `persona_name`，不一定是原始 `persona` key：

```yaml
persona_providers:
  implementation-coder:
    provider: codex
    model: gpt-5
    provider_options:
      codex:
        reasoning_effort: high
```

<a id="auto-routing"></a>

## 自动路由

旧版模式可以在项目或全局 `config.yaml` 中配置 `auto_routing`；runtime 模式使用 `runtime.yaml` 中的 `provider.auto_routing` 和 target profile。workflow YAML 不能启用或覆盖自动路由。

```yaml
provider: codex
model: gpt-5.6-luna

auto_routing:
  strategy: balanced # cost | balanced | performance
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

旧版模式中，顶层 `provider` 和 `model` 是默认值；candidate 只用于 workflow step 执行。没有 workflow-step 上下文的内部操作使用顶层默认值。Assistant 对话不走 auto routing，而解析 `takt_providers.assistant`，必要时回退到顶层 provider/model。runtime 模式下，只有显式选择 pool 的 persona、tag 或 step target 才自动路由。

candidate 的 `routing_tier` 只能是 `high`、`medium` 或 `low`。CLI 可以用 `--auto-strategy cost|balanced|performance` 覆盖策略。路由决策默认不记录；启用 `telemetry.routing_decisions`（`takt telemetry enable` 或 `routing_decisions: true`）后，以 NDJSON 写入项目 `.takt/events/`，不会上传。

provider option 也可以通过环境变量覆盖。例如 OpenCode model variant 使用 `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high`；provider base URL 可使用 `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` 或 `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787`。Pi thinking level 使用 `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL=high` 设置 `provider_options.pi.thinking_level`。DeepSeek Harness 可使用 `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL=http://127.0.0.1:8787/v1`；官方 SDK 读取 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`，TAKT 将其传给官方 TypeScript SDK/runtime。其余 provider option 环境变量按同样的 key 路径规则解析。

### Provider 专属选项

runtime 模式中，执行选项放在 `provider.profiles.<name>.options`；workflow 中只使用 capability。旧版配置仍支持以下 provider-specific option。

#### Provider Base URL（`base_url`）

```yaml
provider_options:
  claude:
    base_url: http://127.0.0.1:8787
  codex:
    base_url: http://127.0.0.1:8787/v1
```

`provider_options.claude.base_url` 会作为 `ANTHROPIC_BASE_URL` 传给 `claude-sdk`、`claude` 和 `claude-headless`；`provider_options.codex.base_url` 作为 `baseUrl` 传给 Codex SDK；`provider_options.deepseek_harness.base_url` 通过 `DEEPSEEK_BASE_URL` 传给官方 TypeScript SDK。workflow 和项目配置只允许 loopback URL；非 loopback endpoint 必须放在全局配置或 `TAKT_PROVIDER_OPTIONS_*_BASE_URL` 环境变量中。

#### DeepSeek Harness (`deepseek-harness`)

TAKT 使用官方 TypeScript SDK（`@deepseek-ai/dsh-sdk-client`）及对应 runtime（`@deepseek-ai/dsh`）。使用此 provider 前请运行 `takt install deepseek-harness`。安装需要连接 npm 注册表，并沿用现有的 npm 注册表和代理设置。优先使用运行 TAKT 的 Node 随附的 npm；如果没有，则使用 `PATH` 中的 npm。SDK 和 runtime 安装在 TAKT 配置目录中（默认 `~/.takt/deepseek-harness/sdk`，可通过 `TAKT_CONFIG_DIR` 更改），不属于 TAKT 本体的 npm 依赖。ready 检查覆盖主要入口、native 文件及必要的包条件，不检查管理目录中的每个文件。未安装、版本不匹配或检测到损坏时，TAKT 会提示重新运行安装命令，不会自动安装。如果检查通过但 provider 仍运行异常，请运行 `takt install deepseek-harness --force` 重新安装。无需 Python 或 uv。支持 glibc `>= 2.28` 的 Linux x64/arm64 和 macOS arm64 `>= 14.0`。

TAKT 随包提供独立的 DeepSeek `package.json` 和 `package-lock.json`。安装命令在临时目录运行 `npm ci --ignore-scripts`，验证 SDK、runtime、`fflate@0.8.3` 和所需 native module 后切换当前安装。支持的平台必须有预构建 native binary。重复运行时，正常安装保持不变。管理侧 manifest 的 `overrides` 将 `fflate` 固定为 `0.8.3`，用于处理 [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)，即使上游 `@deepseek-ai/libreoffice-kit@0.1.5` 声明的是 `0.8.2`。这不代表所有依赖 advisory 都已解决。

配置示例：

```yaml
provider: deepseek-harness
model: deepseek-v4-flash
provider_options:
  deepseek_harness:
    base_url: http://127.0.0.1:8787/v1  # 可选；project/workflow 配置只允许 loopback
    max_tokens: 4096
    request_timeout_ms: 3600000
    shutdown_timeout_ms: 1000
```

`runtime_mode` 和 Python/uv 专用选项已删除，作为未知配置拒绝。`base_url` 的环境变量覆盖项是 `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL`；provider 原生 endpoint 设置为 `DEEPSEEK_BASE_URL`。非 loopback endpoint 只能在 global config 或用户管理的 TAKT 环境变量中设置，workflow/project 配置仅允许 loopback。

请取消设置 `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_RUNTIME_MODE` 和 `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PYTHON_PATH`。即使值为空，只要存在就会导致 project/global config 验证失败；错误消息不会回显这些值。

认证从官方 store `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）或选定的环境变量（例如 `DEEPSEEK_API_KEY`）解析。参照名来自 `$DSH_HOME/settings.yaml` 中的 `llm-deepseek.apiKeyEnv`，未设置时使用 `DEEPSEEK_API_KEY`。若保存了 `llm-deepseek.baseURL`，它必须与有效 endpoint 一致。选定的环境变量优先于已保存的 credential。TAKT 将 store path 和参照名传给 runtime，不读取、复制或改写 secret 值。credential source home 与 TAKT 管理的 runtime home 分开。已有 session 中改变 credential binding 会被拒绝。

runtime 在运行且支持的配置未改变时，可在同一 session 中执行多个 turn，并按 FIFO 顺序串行处理。SDK 无法在 runtime 终止/重启后恢复已保存历史，也无法在配置变化要求替换 runtime 时保留历史。此类继续请求会收到固定诊断。要更改 reasoning effort、model、credential 或 runtime 设置，请使用新的 session identity。TAKT 不重放旧历史，也不通过更换 ID 重跑被拒绝的 turn。后续交互用户 turn 可按下述策略使用新 ID；workflow 仍需新的 TAKT session/run。这是有意的破坏性缩减；跨 runtime 的历史保留延期支持。

为避免 provider 错误正文回显 credential 后被保存或上传到 session 日志，TAKT 会禁用 runtime 的 JSONL session-persistence plugin 和 `dsh_session_log` API 上传。同一 runtime 内的 turn 仍保存在内存中并可继续执行。TAKT 不读取或删除已有的 DeepSeek session 文件。

官方 SDK 的文件操作、搜索、shell、subagent/fork 和 workflow 工具保持启用。与其他本地 coding provider 一样，只应在可信 workspace 中运行；这不保证模型工具无法读取 credential。SDK 的 workspace-write 边界控制写入，而不是 secret 文件读取隔离。认证配置仍只传递 store path/reference，并将 credential binding 与 runtime home 分开。显式要求但不支持的 TAKT 控制仍在启动前拒绝，绝不静默忽略。

初始化 timeout 固定为 30 秒，与 turn 的 `request_timeout_ms` 和 shutdown 的 `shutdown_timeout_ms` 相互独立。SDK runtime 在 supervisor 下启动，该 supervisor 丢弃 stderr 并跟踪 process group。若无法确认 cleanup，所有后续 runtime 启动（包括新 session）都会被阻止，直到旧 process group 确认退出。SDK error 转换为固定诊断；不显示或分类 raw exception message、cause、data 或 stderr。

持有共享 runtime-state lock 的进程被强制终止后，也可能继续阻止启动。lock 不会自动恢复。手动清理 TAKT config directory 中 `deepseek-harness/state/` 下的 `.runtime-state-lock` 和 `cleanup-blocked` 前，必须先确认旧 runtime、supervisor 和工具进程全部退出。不得仅为绕过 cleanup 失败而删除它们。

**旧环境的手动清理：** 先停止所有 TAKT/DeepSeek runtime、supervisor 和工具。检查 TAKT config directory（默认 `~/.takt`）中的 `deepseek-harness/venv/`、`deepseek-harness/pyproject.toml` 和 `deepseek-harness/uv.lock`，备份需要的旧数据后，仅删除确认为 Python 安装产物的文件。当前安装程序仍使用 `deepseek-harness/install.lock` 和 `sdk`，provider 也使用 `dsh-home/` 和 `state/`，不要删除整个 `deepseek-harness/`。旧 profile、plugin 和 session 历史不会导入；需要时请单独归档。若不打算更改认证，保留 `$DSH_HOME/.credentials.yaml` 和 `settings.yaml`，运行安装命令后再启动新的 TAKT session/run。

**runtime 所有权与缓存：** 其他 TAKT 进程的正常 runtime 独占共享 managed home。等待其关闭，或使用单独的 `TAKT_CONFIG_DIR`。这是 home 占用诊断，不是 cleanup 失败，不能通过删除 state 绕过。每个进程最多保留八个 idle runtime，按最近使用顺序淘汰；执行中及排队中的 turn 受保护，可暂时超过八个。被淘汰的 ID 无法恢复历史，继续请求会被明确拒绝；交互恢复先发出通知，下一个用户 turn 才启动新 session。本实例的 supervisor 确认 process group 退出并写入凭证后，SDK close 错误不会创建永久 barrier。owner 列表为空本身不是退出证明；没有确认凭证、owner 损坏或 runtime 未登记时，仍阻止启动。

source maintainer 可运行 `node scripts/verify-deepseek-sdk-lock.mjs --pack`，检查管理侧 lock 和 npm pack 中的 manifest 与 lock。

SDK 不提供此 provider 所需的 permission control，因此请求 permission mode/callback、`bypassPermissions` 或显式 allowed-tools list 的调用会在启动 runtime 前失败。非空 MCP server map、`maxTurns`、structured output 和 image attachment 也无法应用，因此会被拒绝。provider setup 时提供的 agent-level `systemPrompt` 会通过 SDK plugin 应用到 runtime。需要未支持的控制功能时，请使用兼容的 provider。SDK notification/result 会转换为既有的 text、thinking、tool、completion 和 error event。

旧版 Python/uv 管理文件和 `takt deepseek-harness install` 不再使用。TAKT 不会迁移或删除用户文件。如需删除旧 managed environment，请先检查再手动处理；`~/.dsh` credential store 仍由用户管理。

默认交互会话使用 SDK 标准工具；显式 allowlist（包括 `[]`）仍不受支持。report/status phase 保留禁用工具的空 allowlist，在 resume、新 session 重试及 DeepSeek fallback 路径中均会在 SDK 启动前拒绝。这是在执行前防止工具副作用，而不是执行后才检测。请为这些 phase 使用兼容的 provider。

persona 的 first-step 信息将未声明工具保留为 `undefined`，与显式 `[]` 区分；空和非空的显式列表都会传到 DeepSeek guard。DeepSeek 交互失败不使用通用 stale-session retry。拒绝限制时可保留仍运行的 session；遇到 `session_continuation_unsupported` 时则清除保存 ID，并说明下一个用户 turn 将创建没有旧历史的新 SDK session。历史恢复仍等待 SDK 支持，因此允许 ID 改变。不会静默重跑被拒绝的 turn，也不会放宽限制；workflow 继续执行仍需新的 TAKT session/run。

TeamLeader 的 `inspect_tools` 也遵循此区别：规范化保留显式空列表的来源信息，仅 DeepSeek 将其解析为空限制，其他 provider 的原有默认行为不变，初始 step 和显示用 preview 都保留未声明值，显示为 provider 默认值而非无工具。指定 SDK ID 始终是继续请求；没有匹配的 live binding 时，即使没有使用记录 marker，也在 SDK 启动前拒绝。只有通知后的新用户 turn 不带 ID 时，SDK 才生成新 ID。cleanup barrier 仍不能被新 ID 绕过。credential source、reference 或 endpoint 改变属于不可重试的 `credential_binding_changed`，保留原 ID；后续 turn 使用改变后的 binding 仍被拒绝，不进入 fresh-session 恢复。请启动新的 TAKT session/run 使用新 binding，或恢复原 binding 以继续其运行中的 runtime。

#### 网络访问（`network_access`）

provider sandbox 默认阻止 `npm install`、`pip install`、`gradle` 和 `mvn` 等网络命令。Codex：

```yaml
provider_options:
  codex:
    network_access: true
```

OpenCode 通过 `webfetch` / `websearch` 工具权限实现同一抽象：

```yaml
provider_options:
  opencode:
    network_access: true
    allowed_tools: [read, glob, grep, bash, websearch, webfetch]
```

`network_access` 可以设置在 runtime profile 或 capability preset 中；旧版模式也可设置在 routing、项目或全局配置中。`TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS=true` 可作为覆盖。

#### Codex 权限控制（`permission_control`）

Codex 默认使用 TAKT 的权限映射，相当于 `permission_control: takt`，并将解析出的 TAKT `permission_mode` 传给 Codex SDK 的 `sandboxMode`。设置 `network_access` 时也会传入 `networkAccessEnabled`；省略时 Codex 保持默认 `false`。

```yaml
provider_options:
  codex:
    permission_control: codex
    network_access: true
    reasoning_effort: high
    fast_mode: true
    skills:
      repo: true
```

使用 `permission_control: codex` 时，TAKT 从每次 Codex 调用（包括 strict isolated structured 调用）中省略 `sandboxMode` 和 `networkAccessEnabled`，由 Codex 的 `config.toml`、`default_permissions` 和 permission profile 决定实际权限。无论 `network_access` 来自 capability、runtime profile、routing、项目或全局配置，还是环境变量覆盖，解析后的值都会被接受且不会产生警告，但不会用于这些 Codex 权限字段。非交互执行仍会设置 `approvalPolicy: never`，`reasoning_effort`、`fast_mode`、`skills` 等非权限控制选项也会继续生效。

要按名称选择 Codex 配置 profile，请在 `permission_control: codex` 下设置 `config_profile`：

```yaml
provider_options:
  codex:
    permission_control: codex
    config_profile: automation-review
```

环境变量 `TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE=automation-review` 也可以设置它。`config_profile` 只接受由 ASCII 字母、数字、连字符和下划线组成的名称；空值和路径会被拒绝，且只有与 `permission_control: codex` 一起使用时才有效。省略 permission control（默认的 `takt`）或明确设置为 `takt` 都会产生配置错误。TAKT 会将名称作为 `codex exec --profile <name>` 传给 CLI，Codex 从 `$CODEX_HOME/<name>.config.toml` 解析 profile，并按照 Codex 规范决定该文件、基础配置、trusted project 设置和运行时 override 的优先级。项目、workflow 和 capability 的 provider options 均可选择 profile；Codex 会在运行中应用该 profile 的权限设置，因此只应指定可信的配置和 profile 文件。

#### Codex Skill 继承（`skills`）

TAKT workflow 默认不继承 repository 或 user Codex Skill。需要时显式启用：

```yaml
provider_options:
  codex:
    skills:
      repo: true
      user: false
```

`repo` 覆盖执行 CWD 到 repository root 之间的 `.agents/skills`；`user` 覆盖 `$HOME/.agents/skills` 和兼容路径 `$CODEX_HOME/skills`。这些设置不修改 Codex 配置，重试与恢复 session 也保持一致。

#### Claude Skill 继承（`skills`）

`claude-sdk`、`claude`、`claude-headless` 和 `claude-terminal` 默认关闭 filesystem Skill discovery。只有 workflow 有意依赖它们时才启用：

```yaml
provider_options:
  claude:
    skills:
      enabled: true
```

`enabled: false` 时 SDK 收到 `skills: []`，CLI 使用 `--disable-slash-commands`；`enabled: true` 时不添加 Skill 选项，保留 Claude 默认 discovery。

#### Claude Code Sandbox 控制（`allow_unsandboxed_commands`）

`permission_mode: edit` 时，Claude SDK 将 Bash 放在 macOS Seatbelt sandbox 中。若 JVM 构建工具因 `Operation not permitted` 失败，可在保留文件编辑权限控制的同时允许 Bash 脱离 sandbox：

```yaml
provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
```

#### Pi 资源加载（`extensions`、`no_*`）

```yaml
provider_options:
  pi:
    extensions:
      - npm:pi-fff
      # - git:https://github.com/example/pi-extension
      # - /absolute/path/to/local-extension
    no_extensions: true       # 禁用 discovery，但仍加载上面的显式 extension
    no_skills: true           # 禁用 Pi Skill discovery
    no_prompt_templates: true # 禁用 Pi prompt-template discovery
    no_themes: true           # 禁用 Pi theme discovery
    no_context_files: true    # 禁用 Pi context-file discovery
```

没有版本限定的显式 npm source 会依次复用已有的 project scope、user scope 安装；两者都无法解析为启用的资源时，才使用 temporary resolution，并且不会向持久 scope 安装。带版本限定的 npm source 始终使用 temporary resolution。显式资源不会写入 Pi 设置；隐式 project-local Pi 资源不会被信任或加载，只有为显式 npm source 检测到的绝对路径可以从 project package storage 复用。带有内嵌凭据或包含 secret 的 query 参数的 extension URL 会被拒绝。

在 `readonly` 和 `edit` 模式下，每个显式配置的 extension 注册的非 builtin 名称的 tool 会作为一个 trust unit 一起启用。自动 discovery 得到的 ambient extension tool 不会在这些 restrictive mode 中启用。非空的 `allowedTools` 过滤 builtin 名称，也适用于同名的 extension 版本；`allowedTools: []` 会拒绝所有 tool，包括显式 extension tool。仅包含空字符串或空白项的列表也按 deny-all 处理。Pi permission mode 是 active-tool allowlist，而不是操作系统 sandbox；即使 `permission_mode: readonly`，受信任的显式 extension 仍可能运行进程或修改文件。显式 extension 加载失败或 provenance 验证失败时，Pi call 会以错误停止。

未指定 permission mode 时，显式 `allowedTools` 列表也会经过 tool 来源验证。自动发现的 extension tool 即使列在 `allowedTools` 中也会被排除；要启用 extension tool，必须在 `extensions` 中明确配置其来源，并在 `allowedTools` 中列出 tool 名称。配置 extension 不会添加列表以外的 tool。仅包含 skills、prompts 或 themes 的 package 仍可正常加载，且不会因此授权 extension tool。

当显式配置的 extension 在 factory 初始化时注册与 builtin 同名的 tool，extension 版本会像普通 Pi 一样替换 builtin。在 `readonly` 和 `edit` 中，该名称必须符合 mode 的 builtin 权限；如果指定了 `allowedTools`，还必须包含在列表中。未指定 permission mode 且显式指定 `allowedTools`，或 `full` 且列表仅包含 readonly tool 时，该名称也必须在列表中。例如，`readonly` + `['grep']` 不会启用 extension 的 `read`，`edit` + `['read']` 不会启用其 `bash`。被排除的名称不会回退到原来的 builtin。这些分支仍然排除 ambient 覆盖。在包括 `full` 的所有模式中，无法验证 provenance 时会停止 Pi call，包括在 `session_start` 中才更改 builtin 注册来源的情况。

注册来源的完整性检查与权限授予分开处理。`full` 未指定 `allowedTools` 时仍允许所有已注册 tool，并保留 SDK 的有效 active-tool 选择。cached call、registry refresh、直接选择 tool，以及普通或 nested tool 执行前都会验证 provenance。合法动态注册仍受支持；来源被篡改时会禁用全部 tool、终止执行，并在同一 logical session 中保持失败状态。

<a id="pi-system-prompt"></a>

#### Pi 的 system prompt（`system_prompt_mode`）

`provider_options.pi.system_prompt_mode` 控制 TAKT 如何将其 runtime prompt（persona、workflow context、step 指令）传给 Pi SDK。

```yaml
provider_options:
  pi:
    system_prompt_mode: append  # 默认
```

- `append`（默认）：TAKT 的 runtime prompt 会追加在 Pi 自身的 system prompt 之后。Pi 内置的指令（文档指引、tool 使用规范、skill catalog）会被保留
- `replace`：用 TAKT 的 runtime prompt 替换 Pi 的 system prompt。用于保持旧行为，或希望自行控制 Pi system prompt 的场景

在 SDK 型 provider 中，Pi 是唯一内置 prompt 较大、丢弃后会改变行为的 provider。CLI 型 provider（Codex、Cursor、Copilot、Kiro）在收到 TAKT 的 prompt 时不会丢失自身指令，因此 `append` 使各 provider 行为一致。`replace` 可以缩短每次请求，也适合按 persona 或 step 区分使用。

<a id="workflow-categories"></a>

## Workflow 分类

在 `takt` workflow 选择提示中使用分类组织 workflow：

### 配置

```yaml
# ~/.takt/preferences/workflow-categories.yaml
workflow_categories:
  Development:
    workflows:
      - default: "标准编码工作流"   # 名称: 描述，在选择项标签中追加描述
      - simple
    Backend:
      workflows: [dual-cqrs]
    Frontend:
      workflows: [dual]
  Research:
    workflows: [research, magi]

show_others_category: true
others_category_name: "Other Workflows"
```

规范 key 是顶层 `workflow_categories`，以及每个分类下列出 workflow 名称（workflow YAML 的 `name` 字段）的 `workflows` 数组。分类文件可以是 builtin `builtins/{lang}/workflow-categories.yaml`、用户 overlay `~/.takt/preferences/workflow-categories.yaml`，或由 `workflow_categories_file` 指定的路径；不能把 `workflow_categories` 直接写入 `~/.takt/config.yaml`。

### 分类功能

- **嵌套分类**：支持任意深度；除 `workflows` 外的 key 都作为子分类名称，不使用 `children:`。
- **每类 workflow 列表**：`workflows:` 保存该分类显示的 workflow 名称。
- **Workflow 描述**：把 `workflows:` 条目写成 `- 名称: 描述` 即可在选择项标签中追加简短说明（纯字符串条目仍然可用）。同一 workflow 列入多个分类时，每处都写相同的描述；同一文件内为同名 workflow 写不同描述会报 validation error。用户 overlay 按 workflow 名称覆盖 builtin，也可以添加仅用户存在的名称。
- **Others 分类**：收集未列入任何分类的 workflow，可用 `show_others_category: false` 关闭。
- **Builtin 过滤**：用 `enable_builtin_workflows: false` 关闭全部 builtin，或用 `disabled_builtins: [name1, name2]` 关闭指定名称。

### 重置分类

重置为 builtin 默认分类：

```bash
takt reset categories
```

## Pipeline 模板

### 配置

Pipeline 模式（`--pipeline`）支持自定义分支名、commit message 和 PR body：

```yaml
# ~/.takt/config.yaml
pipeline:
  default_branch_prefix: "takt/"
  commit_message_template: "feat: {title} (#{issue})"
  pr_body_template: |
    ## Summary
    {issue_body}
    Closes #{issue}
```

### 模板变量

| 变量 | 可用位置 | 说明 |
|------|----------|------|
| `{title}` | commit message | Issue 标题 |
| `{issue}` | commit message、PR body | Issue 编号 |
| `{issue_body}` | PR body | Issue 正文 |
| `{report}` | PR body | workflow 执行报告 |

### Pipeline CLI 选项

| 选项 | 说明 |
|------|------|
| `--pipeline` | 启用 pipeline（非交互）模式 |
| `--auto-pr` | 执行后创建 PR |
| `--draft` | 创建 draft PR（需要 `--auto-pr` 或 `auto_pr` 配置） |
| `--skip-git` | 跳过分支创建、commit 和 push（仅执行 workflow） |
| `--repo <owner/repo>` | 创建 PR 的仓库 |
| `--auto-strategy <strategy>` | 覆盖自动路由策略（`cost`、`balanced`、`performance`） |
| `-q, --quiet` | 最小输出模式（抑制 AI 输出） |

## 调试

### Debug 日志

在全局 `~/.takt/config.yaml` 中启用：

```yaml
logging:
  debug: true
```

常规 debug 日志按进程写入 `.takt/runs/debug-{timestamp}/logs/debug-{timestamp}.log`，格式为 NDJSON。prompt/response 日志按 workflow run 写入 `.takt/runs/<run>/logs/<sessionId>-prompts.jsonl`。

### 详细控制台输出

```yaml
# ~/.takt/config.yaml
logging:
  level: debug
```

`logging.level: debug` 会启用 CLI 的详细输出，以及上面按进程保存的常规 debug 日志和按 workflow run 保存的 prompt/response 日志；`logging.debug: true`、`logging.trace: true` 或 `logging.level: debug` 任一设置都可以生成这些产物。

## Companion Provider Target

Companion 需要有效的 `runtime.yaml` provider section。通过 `provider.targets.companions` 为每个引用的 companion 分配 profile；省略名称时使用 `provider.defaults`。Companion target 必须指定固定 profile，pool 和 ladder 会在解析 `runtime.yaml` 时被拒绝。

```yaml
version: 1
provider:
  profiles:
    review:
      provider: codex
      model: gpt-5
  defaults:
    profile: review
  targets:
    companions:
      security-reviewer:
        profile: review
```

Companion 的 structured call 使用和其他 TAKT-owned structured agent 一样的 provider-neutral 新 session transport。具备原生 structured output 时直接使用，否则使用经过验证的 JSON fallback。Companion reviewer、moderator 和 selector 始终以 `readonly` 权限运行，不使用 resolved profile 上配置的权限模式。

| Provider | Implementer tool event |
|----------|------------------------|
| `claude-sdk` / `claude` | Live |
| `codex` | Live |
| `claude-headless` | Live |
| `claude-terminal` | turn 后 replay |
| `mock` | 取决于 scenario |
| `opencode` | Live |
| `pi` | Live |
| `cursor`、`copilot`、`kiro` | 不可用 |

当 live tool event 不可用时，完成审查和 turn 边界的 finding 传递仍会运行。
