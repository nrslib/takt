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
provider: claude              # 默认 provider：claude、claude-sdk、claude-terminal、codex、opencode、deepseek-harness、cursor、copilot、kiro、pi 或 mock
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
concurrency: 1                # takt run 的并行任务数（1-10，默认 1 = 顺序执行）
task_poll_interval_ms: 500    # takt run 检查新任务的间隔（100-5000，默认 500）
interactive_preview_steps: 3  # 交互模式中的 step 预览数（0-10，默认 3）
auto_requeue_max_attempts: 0  # takt run 期间失败 workflow task 的自动 requeue 次数（非负整数，默认 0 = 禁用）
ignore_exceed: false          # 对 takt run 和 takt watch 应用 --ignore-exceed（默认 false）
assistant:
  formal_spec: 'y/N'          # Alloy/Quint 模式：true、false、Y/n 或 y/N（默认 y/N）
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
#   claude:
#     default_permission_mode: edit

# API key 配置（可选）
# 可由 TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY 覆盖。DeepSeek Harness 使用官方 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 环境变量，而不是 YAML API key 字段。
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
#     provider: claude
#     model: opus
#   selector:              # dynamic parallel、dynamic_facets 和 companion pool 的可选 selector 覆盖
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` 是可选项。provider/model 的优先级为显式 CLI 或环境变量覆盖、项目 selector、全局 selector、项目顶层、全局顶层。model 只有在其 candidate 属于解析出的 provider 时才有效。只有 selector 条目提供 `provider_options`，并按 option leaf 从全局到项目合并；顶层、persona 和 pool sub-step 的 options 不会传给 selector。空 selector 条目或空 `provider_options` 条目会在加载配置时被拒绝。dynamic parallel 和 `dynamic_facets` selector 使用 provider-neutral 的新 session，并传入固定的只读工具 allowlist `Read`、`Glob`、`Grep` 以及 `permission_mode: readonly`。Companion selector 不接收固定的 `allowedTools` 列表，因此可以使用 selector profile 中的 `allowed_tools`。工具 allowlist 只对遵守它的 provider 生效。没有 dynamic parallel、dynamic facets 或启用的 companion pool 时，selector 设置不会使用，也不会影响 workflow。

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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | 默认 AI provider；`deepseek-harness` 是官方 DeepSeek Harness Python SDK |
| `model` | string | - | 默认 model 名称，原样传给 provider |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | 分支名生成策略 |
| `prevent_sleep` | boolean | `false` | 阻止 macOS 空闲睡眠 |
| `notification_sound` | boolean | `true` | 启用通知音 |
| `notification_sound_events` | object | - | 各事件通知音开关 |
| `concurrency` | number (1-10) | `1` | `takt run` 并行任务数 |
| `task_poll_interval_ms` | number (100-5000) | `500` | 新任务轮询间隔 |
| `interactive_preview_steps` | number (0-10) | `3` | 交互模式中的 step 预览数 |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` | `"y/N"` | 仅在存在适用要求时添加相应的 Alloy/Quint 指导；每项要求只使用所需记法，不在多种记法中重复同一要求，也不强制同时使用两种记法。`true` 和 `false` 不提问；TTY 下 `"Y/n"`、`"y/N"` 每个会话提问一次并分别以 Yes、No 为默认值；非 TTY 不读取标准输入，直接采用默认答案。项目显式值优先于全局值。Gherkin 指导始终启用。 |
| `auto_requeue_max_attempts` | 非负整数 | `0` | 失败 workflow task 的自动 requeue 上限；`0` 禁用 |
| `ignore_exceed` | boolean | `false` | 配置 `takt run` 和 `takt watch` 的迭代上限绕过 |
| `sync_project_local_takt_on_retry` | boolean | `true` | retry/re-execution 前将根项目 `.takt` 同步到 worktree |
| `worktree_dir` | string | - | shared clone 目录，默认 `../{clone-name}` |
| `allow_git_hooks` | boolean | `false` | 允许 TAKT 管理的自动 commit 运行 git hooks |
| `allow_git_filters` | boolean | `false` | 允许 TAKT 管理的自动 commit 运行 git filters |
| `auto_pr` | boolean | - | worktree 执行后自动创建 PR |
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

## 项目配置

在 `.takt/config.yaml` 中设置项目专属配置。第一次在项目目录使用 TAKT 时会创建该文件。

```yaml
# .takt/config.yaml
provider: claude              # 覆盖项目的 provider
model: sonnet                 # 覆盖项目的 model
auto_pr: true                 # worktree 执行后自动创建 PR
concurrency: 2                # 此项目 takt run 的并行任务数（1-10）
auto_requeue_max_attempts: 1  # takt run 期间失败 workflow task 的自动 requeue 次数
ignore_exceed: false          # 对 takt run 和 takt watch 应用 --ignore-exceed
# base_branch: main           # 创建 clone 的基分支（覆盖全局值，默认 remote 默认分支）

# 项目专属的 assistant 设置
# assistant:
#   formal_spec: 'Y/n'         # 覆盖全局 Alloy/Quint 模式；TTY 下以 Yes 为默认值提问
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
#     # python_path 和 cordis 仅允许受信任的全局配置/环境变量；项目配置
#     # 使用默认 python3，不能选择 Cordis 可执行配置。
#     base_url: http://127.0.0.1:8787/v1
#     session_root: .takt/deepseek-sessions
#     max_tokens: 4096
#     request_timeout_ms: 3600000
#     shutdown_timeout_ms: 1000
#     runtime_mode: exe
#   claude_terminal:
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

需要将 Pi 设为默认值时，请在 TAKT 配置中显式指定 model。Pi model 可以带 `:<thinking-level>` 后缀：

```yaml
# ~/.takt/config.yaml 或 .takt/config.yaml
provider: pi
model: provider/model:high
```

也可以在 workflow step 上设置 model 和 thinking level：

```yaml
steps:
  - name: implement
    provider: pi
    model: provider/model:high
```

`provider` 和 `model` 声明选择 TAKT run 的 provider、model 和 thinking level；它们不会导入 Pi CLI 设置。Pi 认证由 Pi SDK credential store 或 provider 原生环境变量单独处理。`provider_options.pi` 是加载 `extensions` 和 `no_*` discovery 控制的独立路径；没有版本限定的显式 npm source 会依次复用已有的 project scope、user scope，只有两者都无法成功加载时才使用 temporary resolution；带版本的 npm source 和非 npm source 始终使用 temporary resolution。显式资源不会写入 Pi 设置。

### Provider inactivity deadline 与 OpenCode execution guard

所有 provider 都使用 `guards.call_timeout_ms` 作为没有可观察 provider event 时允许的最长时间。每个 stream/tool event、阶段完成和新的 provider attempt 都会重置计时器；累计执行时间没有上限。它适用于 `codex`、`opencode`、`claude`（包括 `claude-sdk`）、`claude_terminal`、`cursor`、`copilot`、`kiro` 和 `pi`。取值是 60,000 到 86,400,000 之间的整数毫秒，默认 3,600,000 ms（60 分钟）。通常的 `provider_options` profile 解析路径会将该值应用到 engine 的 parent-step deadline，并向所有 provider 传递同一个 `AbortSignal`。`claude_terminal.timeout_ms` 为兼容性保留，仅在未设置 `guards.call_timeout_ms` 时使用。

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
| `draft_pr` | boolean | `false`（来自全局） | 将自动创建的 PR 设为 draft |
| `concurrency` | number (1-10) | `1`（来自全局） | `takt run` 并行任务数 |
| `auto_requeue_max_attempts` | 非负整数 | `0` | 失败 workflow task 的自动 requeue 上限 |
| `ignore_exceed` | boolean | `false` | `takt run` / `takt watch` 的迭代限制绕过 |
| `base_branch` | string | - | 创建 clone 的基分支 |
| `assistant.init_files` | string[] | - | 仅项目级的 assistant 初始上下文文件。路径必须相对于项目根；绝对路径、解析到项目根之外的路径，以及 `.env*`、`.npmrc`、`.pypirc`、`.netrc`、`*.pem`、`*.key` 和 `.git/**` 等敏感文件模式会被拒绝。路径不存在、指向目录或文件不可读时会明确报错。最多 16 个文件，每个最多 256 KiB，合计最多 1 MiB。未设置或为空时，TAKT 不会自动发现 `CLAUDE.md`、`AGENT.md`、`AGENTS.md`、`TAKT.md` 或其他文件。 |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` | `"y/N"`（来自全局/默认值） | 仅在存在适用要求时添加相应 Alloy/Quint 指导的项目级覆盖；每项要求只使用所需记法，不在多种记法中重复同一要求，也不强制同时使用两种记法。项目值优先于全局值。提示回答仅在当前会话中生效，恢复会话时重新解析。ACP 和非 TTY 不提问，使用配置的默认答案。Gherkin 始终启用。已弃用的 `assistant.gherkin` 会警告后忽略，不转换、不持久化，也不修改配置文件。 |
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

TAKT 支持 Claude、Codex、OpenCode、Pi、官方 DeepSeek Harness SDK、Cursor、Copilot 和 Kiro provider。Claude/Codex/OpenCode 使用各自 SDK credential，Pi 使用 Pi SDK credential store 或 provider 原生环境变量，DeepSeek Harness 使用官方 `DEEPSEEK_API_KEY`，Cursor 支持 API key 或已有 `cursor-agent login` session，Copilot 使用 GitHub token，Kiro 使用 API key。

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

# 官方 DeepSeek Harness SDK（Python 3.10+ runtime）
export DEEPSEEK_API_KEY=...
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
| DeepSeek Harness | `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`） | - |
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |
| Kiro CLI | `TAKT_KIRO_API_KEY`（`KIRO_API_KEY` fallback） | `kiro_api_key` |

如果将 API key 写入配置文件，请勿将该文件 commit 到 Git；更推荐环境变量，并可将 `~/.takt/config.yaml` 加入全局 `.gitignore`。

### 安全

DeepSeek API key 只传给 Python bridge 环境，不会出现在命令参数或 workflow 生成的配置中。Windows 和 macOS x64 不支持 DeepSeek Harness。Cursor 已有 `cursor-agent login` session 时可以不设置 API key；Copilot 和 Kiro 仍需各自的 CLI。

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

- **Claude Code** 支持 `opus`、`sonnet`、`haiku`、`opusplan`、`default` 等别名和完整 model 名称；`model` 原样传给 provider CLI。可用 model 参见 [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)。
- **Codex** 通过 Codex SDK 原样使用 model 字符串；省略时默认 `codex`。
- **OpenCode** 要求 `provider/model` 格式，例如 `opencode/big-pickle`；省略 model 会产生配置错误。
- **Pi** 接受 `provider/model` 引用或能唯一匹配 Pi model 的裸 ID；识别到 `:<thinking-level>` 后缀时选择 Pi thinking level。
- **Cursor Agent** 将 model 原样传给 `cursor-agent --model <model>`。
- **GitHub Copilot CLI** 将 model 原样传给 `copilot --model <model>`。
- **Kiro CLI** 将 model 原样传给 `kiro-cli chat --model <model>`。

### 示例

```yaml
# ~/.takt/config.yaml
provider: claude
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

### 按目录选择 assignment

`provider.assignments` 用于定义按项目目录选择的命名 provider 配置集合。每个 entry 必须至少包含
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
| `readonly` | 只读，不修改文件 | `default` | `read-only` | `read-only` | `read`、`grep`、`find`、`ls` | Cordis 配置 | 默认 flags（无 `--force`） | 无权限 flags | `--trust-tools=read,grep` |
| `edit` | 允许带确认的文件编辑 | `acceptEdits` | `workspace-write` | `workspace-write` | `read`、`grep`、`find`、`ls`、`edit`、`write`、`bash` | Cordis 配置 | 默认 flags（无 `--force`） | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | 绕过所有权限检查 | `bypassPermissions` | `danger-full-access` | `danger-full-access` | 所有注册 Pi 工具 | Cordis 配置 | `--force` | `--yolo` | `--trust-all-tools` |

Pi 的权限模式是 SDK active-tool allowlist，而不是操作系统 sandbox；TAKT 不为 Pi 增加逐工具确认。使用 Pi 时请确保 workflow 输入和 extension 可信。

### 配置

```yaml
# ~/.takt/config.yaml（全局）或 .takt/config.yaml（项目）
provider_profiles:
  codex:
    default_permission_mode: full
    step_permission_overrides:
      ai_review: readonly
  claude:
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

provider 和 model 在每一层独立解析；只有 provider 的覆盖不会替换更高优先级的 model 覆盖。workflow YAML 没有 provider/model 层；workflow promotion 只推进 runtime target ladder。

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

provider option 也可以通过环境变量覆盖。例如 OpenCode model variant 使用 `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high`；provider base URL 可使用 `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` 或 `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787`。DeepSeek Harness 可使用 `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL=http://127.0.0.1:8787/v1`；官方 SDK 读取 `DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_BASE_URL`，TAKT 只将其传给私有 Python bridge。其余 provider option 环境变量按同样的 key 路径规则解析。

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

`provider_options.claude.base_url` 会作为 `ANTHROPIC_BASE_URL` 传给 `claude` 和 `claude-sdk`；`provider_options.codex.base_url` 作为 `baseUrl` 传给 Codex SDK；`provider_options.deepseek_harness.base_url` 通过 `DEEPSEEK_BASE_URL` 传给官方 Python SDK。workflow 和项目配置只允许 loopback URL；非 loopback endpoint 必须放在全局配置或 `TAKT_PROVIDER_OPTIONS_*_BASE_URL` 环境变量中。

#### DeepSeek Harness（`deepseek-harness`）

`deepseek-harness` 在 Python 3.10+ 子进程中启动官方 `deepseek-harness-sdk`，通过逐行 JSON-RPC bridge 通信。请单独安装匹配的 runtime：

```bash
python3 -m pip install deepseek-harness-sdk deepseek-harness-runtime-bin
```

官方 runtime wheel 支持 Linux x64/arm64 和 macOS arm64；Windows 与 macOS x64 会快速失败，TAKT 不会 fallback。认证使用环境变量 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`；API key 不会写入 workflow/config 或命令参数。

```bash
export DEEPSEEK_API_KEY=your-key
export TAKT_DEEPSEEK_HARNESS_LIVE=1
npm run test:deepseek-harness:live
```

```yaml
provider: deepseek-harness
model: deepseek-v4-flash
provider_options:
  deepseek_harness:
    base_url: http://127.0.0.1:8787/v1  # 可选；项目/workflow 配置中使用 loopback
    session_root: .takt/deepseek-sessions
    max_tokens: 4096
    request_timeout_ms: 3600000
    shutdown_timeout_ms: 1000
    runtime_mode: exe                  # exe 或 node；node 仅用于显式 SDK 开发模式
```

`python_path` 和 `cordis` 只允许来自受信任的全局配置或对应环境变量；项目设置使用默认 `python3`。`session_root` 和 `cordis` 相对配置的工作目录解析。带有 `session_key` 的 workflow 会复用 session；one-shot call 会立即关闭 bridge。官方 event 会转换成 TAKT 的 text、thinking、tool-use、tool-result、error 和 result event。system prompt、TAKT `allowed_tools`、MCP server map、图片附件、structured output、permission mode 和 `maxTurns` 不属于官方 SDK 调用，会被警告并忽略；工具组合请通过 Cordis 配置。

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
```

使用 `permission_control: codex` 时，TAKT 从每次 Codex 调用中省略 `sandboxMode` 和 `networkAccessEnabled`，由 Codex 的 `config.toml`、`default_permissions` 和 permission profile 决定实际权限。它不能与 `network_access` 同时设置；同时存在会快速失败。

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

`claude-sdk`、`claude` 和 `claude-terminal` 默认关闭 filesystem Skill discovery。只有 workflow 有意依赖它们时才启用：

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
| `claude-sdk` | Live |
| `codex` | Live |
| `claude`（headless） | Live |
| `claude-terminal` | turn 后 replay |
| `mock` | 取决于 scenario |
| `opencode` | Live |
| `pi` | Live |
| `cursor`、`copilot`、`kiro` | 不可用 |

当 live tool event 不可用时，完成审查和 turn 边界的 finding 传递仍会运行。
