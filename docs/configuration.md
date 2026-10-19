# Configuration

[English](./configuration.md) | [日本語](./configuration.ja.md) | [简体中文](./configuration.zh-CN.md)

This document is a reference for all TAKT configuration options. For a quick start, see the main [README](../README.md).
For phase-level usage events and analysis, see the [Observability Guide](./observability.md).

## Global Configuration

Configure TAKT defaults in `~/.takt/config.yaml`. This file is created automatically on first run. All fields are optional.

If the global configuration directory and the current project's `.takt/` point to the same place, TAKT exits with an error at startup. If they overlap in your home directory or through a symbolic link, set `TAKT_CONFIG_DIR` to a different directory.

```yaml
# ~/.takt/config.yaml
language: en                  # UI language: 'en' or 'ja'
logging:
  level: info                 # Log level: debug, info, warn, error
provider: claude-sdk              # Default provider: claude-sdk, claude, claude-headless, claude-terminal, codex, opencode, deepseek-harness, cursor, copilot, kiro, pi, or mock
model: sonnet                 # Default model (optional, passed to provider as-is)
branch_name_strategy: romaji  # Branch name generation: 'romaji' (fast) or 'ai' (slow)
prevent_sleep: false          # Prevent macOS idle sleep during execution (caffeinate)
notification_sound: true      # Enable/disable notification sounds
notification_sound_events:    # Optional per-event toggles (all events enabled by default)
  iteration_limit: false      # Example: set false to disable only this event
  workflow_complete: true
  workflow_abort: true
  run_complete: true
  run_abort: true
concurrency: 1                # Parallel task count for takt run / takt watch (1-10, default: 1 = sequential)
task_poll_interval_ms: 500    # Polling interval for new tasks during takt run / takt watch (100-5000, default: 500)
interactive_preview_steps: 3  # Step previews in interactive mode (0-10, default: 3)
auto_requeue_max_attempts: 0  # Auto-requeue failed workflow tasks during takt run / takt watch (non-negative integer, default: 0 = disabled)
ignore_exceed: false          # Applies to takt run and takt watch like --ignore-exceed (default: false)
assistant:
  formal_spec:
    mode: 'y/N'                # Alloy/Quint mode: true, false, Y/n, or y/N (default: y/N)
    comments: true             # Add natural-language meaning comments to each formal construct (default: true)
    model_check_timeout_seconds: 900  # Limit for /verify quint verify and Alloy model checking, integer 1-86400 (default: 900)
# auto_fetch: false           # Fetch remote before cloning (default: false)
# base_branch: main           # Base branch for clone creation (default: remote default branch)

# Runtime environment defaults (applies to all workflows unless workflow_config.runtime overrides)
# runtime:
#   prepare:
#     - gradle    # Prepare Gradle cache/config in .runtime/
#     - node      # Prepare npm cache in .runtime/

# Provider routing for workflow steps (recommended)
# Route by raw persona key, step tags, or step name without duplicating workflows
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

# Legacy per-display-name overrides (deprecated; prefer provider_routing)
# persona_providers:
#   coder:
#     provider: codex
#     model: gpt-5

# Provider-specific permission profiles (optional)
# Priority: project override > global override > project default > global default > required_permission_mode (floor)
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly
#   claude-sdk:
#     default_permission_mode: edit

# API Key configuration (optional)
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY. DeepSeek Harness uses its official credential store ($DSH_HOME/.credentials.yaml, default ~/.dsh/.credentials.yaml) or DEEPSEEK_API_KEY, with optional DEEPSEEK_BASE_URL (not YAML API-key fields).
# anthropic_api_key: sk-ant-...  # For Claude (Anthropic)
# openai_api_key: sk-...         # For Codex (OpenAI)
# opencode_api_key: ...          # For OpenCode
# cursor_api_key: ...            # For Cursor Agent (optional; login session fallback is also supported)
# copilot_github_token: ...      # For Copilot (GitHub token)
# kiro_api_key: ...              # For Kiro CLI

# CLI path overrides (optional)
# Override provider CLI binaries (must be absolute paths to executable files)
# Can be overridden by environment variables TAKT_CLAUDE_CLI_PATH / TAKT_CODEX_CLI_PATH / TAKT_CURSOR_CLI_PATH / TAKT_COPILOT_CLI_PATH / TAKT_KIRO_CLI_PATH
# claude_cli_path: /usr/local/bin/claude
# codex_cli_path: /usr/local/bin/codex
# cursor_cli_path: /usr/local/bin/cursor-agent
# copilot_cli_path: /usr/local/bin/github-copilot-cli
# kiro_cli_path: /usr/local/bin/kiro-cli

# VCS provider (optional)
# Auto-detected from git remote URL (github.com → github, gitlab.com → gitlab)
# Set explicitly for self-hosted instances
# vcs_provider: github                   # 'github' or 'gitlab'

# Assistant provider (optional)
# Routes assistant conversations (interactive planning, instruct on existing tasks,
# and retry dialogue) and the Report phase fallback provider.
# Report fallback uses this only after an OpenCode report retry fails.
# Project assistant overrides global assistant; when assistant is unset, TAKT does not
# fall back to top-level provider/model for report fallback.
# takt_providers:
#   assistant:
#     provider: claude-sdk
#     model: opus
#   selector:              # optional selector override for dynamic parallel, dynamic_facets, and companion pools
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` selects agents for dynamic parallel, `dynamic_facets`, and Companion pools. Provider and model precedence is explicit CLI or environment override, project selector, global selector, project top-level, then global top-level. The model must belong to the selected provider.

The selector's `provider_options` merge individual options from the global and project selector settings. Environment variables for the selected provider can override them. Top-level, persona, and pool sub-step options do not carry over to the selector. To use `config_profile` with a Codex selector, also set `permission_control: codex` in that selector's effective options. Empty selector or `provider_options` entries are errors.

Dynamic parallel and `dynamic_facets` selectors use read-only mode with only `Read`, `Glob`, and `Grep` allowed. Companion selectors can use the configured `allowed_tools` because TAKT does not pass them a fixed tool list. Tool restrictions depend on provider support.

```yaml
# ~/.takt/config.yaml (continued)

# Workflow security policies (all default to deny)
# These settings control what untrusted workflow YAMLs are allowed to do.
# workflow_mcp_servers:                  # MCP server transport policy
#   stdio: true                          # Allow stdio transport (default: false)
#   sse: false                           # Allow SSE transport (default: false)
#   http: false                          # Allow HTTP transport (default: false)
# workflow_arpeggio:                     # Arpeggio custom code policy
#   custom_data_source_modules: false    # Allow custom data source modules (default: false)
#   custom_merge_inline_js: false        # Allow inline JS merge functions (default: false)
#   custom_merge_files: false            # Allow external merge files (default: false)
# workflow_runtime_prepare:              # Runtime prepare policy
#   custom_scripts: false                # Allow custom scripts (default: false; builtin presets always allowed)
# workflow_command_gates:                # Workflow YAML command quality gate policy
#   custom_scripts: false                # Allow command gates from workflow YAML (default: false)
# sync_conflict_resolver:                # Sync conflict resolver policy
#   auto_approve_tools: false            # Allow auto-approval of tools (default: false)

# Builtin workflow filtering (optional; config keys retain workflow_* names)
# enable_builtin_workflows: true         # Set false to disable all builtin workflows
# disabled_builtins: [magi]              # Disable specific builtin workflows by name

# Pipeline execution configuration (optional)
# Customize branch names, commit messages, and PR body.
# pipeline:
#   default_branch_prefix: "takt/"
#   commit_message_template: "feat: {title} (#{issue})"
#   pr_body_template: |
#     ## Summary
#     {issue_body}
#     Closes #{issue}

# Routing decision telemetry is local-only.
# telemetry:
#   routing_decisions: true       # Write auto-routing decisions to .takt/events/ (default: false; enable with `takt telemetry enable` or this key)
```

### Global Config Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI language |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Log level |
| `logging.trace` | boolean | `false` | Enable trace-level logging (suppresses high-frequency debug noise) |
| `logging.debug` | boolean | `false` | Enable debug logging (`debug.log` + `prompts.jsonl`) |
| `logging.provider_events` | boolean | `false` | Persist provider stream events |
| `logging.usage_events` | boolean | `false` | Persist usage event logs |
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-headless"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude-sdk"` | Default concrete AI provider (`claude-sdk` = Agent SDK mode, `claude` = alias for `claude-sdk`, `claude-headless` = headless CLI mode, `claude-terminal` = experimental interactive terminal mode, `pi` = Pi SDK mode, `deepseek-harness` = official DeepSeek Harness TypeScript SDK/runtime `0.2.1-alpha.2`) |
| `model` | string | - | Default model name (passed to provider as-is) |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | Branch name generation strategy |
| `prevent_sleep` | boolean | `false` | Prevent macOS idle sleep (caffeinate) |
| `notification_sound` | boolean | `true` | Enable notification sounds |
| `notification_sound_events` | object | - | Per-event notification sound toggles |
| `concurrency` | number (1-10) | `1` | Parallel task count for `takt run` / `takt watch` |
| `task_poll_interval_ms` | number (100-5000) | `500` | Polling interval for new tasks (`takt run` / `takt watch`) |
| `interactive_preview_steps` | number (0-10) | `3` | Step previews in interactive mode |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` \| object | mode `"y/N"`, comments `true` | Adds Alloy/Quint guidance and expresses requirements in both notations. The structured form accepts independent `mode`, `comments`, and `model_check_timeout_seconds` fields; `comments: false` removes only the natural-language meaning-comment instruction and does not reduce formal specification coverage, requirement coverage, or syntax/correctness guidance. `model_check_timeout_seconds` is the limit in seconds for `quint verify` and the Alloy Analyzer during `/verify` (an integer from 1 to 86,400, default 900); the 60-second limit for `parse`/`typecheck`/`run` is unchanged. Project and global object fields are resolved independently, with project values taking precedence. `true` and `false` are used without prompting; on a TTY, `"Y/n"` and `"y/N"` ask once per conversation session with Yes or No as the default; without a TTY, the default answer is used without consuming standard input. Gherkin guidance applies only to development and implementation tasks. |
| `auto_requeue_max_attempts` | non-negative integer | `0` | Maximum automatic requeue attempts for failed workflow tasks during `takt run` / `takt watch`; `0` disables automatic requeue |
| `ignore_exceed` | boolean | `false` | Configures iteration-limit bypass for `takt run` and `takt watch`; a CLI `--ignore-exceed` flag takes precedence when specified |
| `sync_project_local_takt_on_retry` | boolean | `true` | Sync the root project-local `.takt` into a reused worktree before selecting a retry position or checking SDKs. Synced files remain if SDK installation is declined or the selection is cancelled. Set `false` to keep the worktree copy. |
| `worktree_dir` | string | - | Directory for shared clones (defaults to `../{clone-name}`) |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `caccia` | object | `{ enabled: false, wait_timeout_ms: 1800000, max_iterations: 3, workflow: "caccia" }` | CodeRabbit review-loop settings; see [Caccia Review Loop](#caccia-review-loop) |
| `draft_pr` | boolean | `false` | Create the auto-created PR as a draft |
| `minimal_output` | boolean | `false` | Suppress AI output (for CI) |
| `runtime` | object | - | Runtime environment defaults (e.g., `prepare: [gradle, node]`) |
| `provider_routing` | object | - | Recommended workflow-step provider/model/provider_options routing by raw persona key, step tag, and step name |
| `auto_routing` | object | - | Automatic provider/model selection from candidate pools (see [Auto Routing](#auto-routing)) |
| `persona_providers` | object | - | Deprecated legacy per-display-name provider/model/provider_options overrides. Prefer `provider_routing` for new settings |
| `provider_options` | object | - | Global provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |
| `rate_limit_fallback` | object | - | Rate-limit fallback; `switch_chain` lists `{provider, model}` entries switched to in order when a provider is rate limited |
| `anthropic_api_key` | string | - | Anthropic API key for Claude |
| `openai_api_key` | string | - | OpenAI API key for Codex |
| `gemini_api_key` | string | - | Gemini API key |
| `google_api_key` | string | - | Google API key |
| `groq_api_key` | string | - | Groq API key |
| `openrouter_api_key` | string | - | OpenRouter API key |
| `opencode_api_key` | string | - | OpenCode API key |
| `cursor_api_key` | string | - | Cursor API key (optional; login session fallback supported) |
| `copilot_github_token` | string | - | GitHub token for Copilot CLI authentication |
| `kiro_api_key` | string | - | Kiro API key |
| `codex_cli_path` | string | - | Codex CLI binary path override (absolute) |
| `claude_cli_path` | string | - | Claude Code CLI binary path override (absolute) |
| `cursor_cli_path` | string | - | Cursor Agent CLI binary path override (absolute) |
| `copilot_cli_path` | string | - | Copilot CLI binary path override (absolute) |
| `kiro_cli_path` | string | - | Kiro CLI binary path override (absolute) |
| `enable_builtin_workflows` | boolean | `true` | Enable builtin workflows |
| `disabled_builtins` | string[] | `[]` | Builtin workflows to disable, by workflow `name` |
| `pipeline` | object | - | Pipeline template settings |
| `bookmarks_file` | string | - | Path to bookmarks file |
| `auto_fetch` | boolean | `false` | Fetch remote before cloning to keep clones up-to-date |
| `base_branch` | string | - | Base branch for clone creation (defaults to remote default branch) |
| `workflow_categories_file` | string | - | Path to categories file (see [Workflow categories](#workflow-categories); default overlay path uses `workflow-categories.yaml`) |
| `vcs_provider` | `"github"` \| `"gitlab"` | auto-detect | VCS provider (auto-detected from git remote URL) |
| `takt_providers` | object | - | TAKT internal provider overrides. `assistant` routes assistant conversations (interactive planning, instruct on existing tasks, and retry dialogue) and is also used as the Report phase fallback provider after an OpenCode report retry fails. Project `takt_providers.assistant` overrides global `takt_providers.assistant`; if neither is set, Report phase fallback is disabled and top-level `provider` / `model` are not used as an implicit fallback. |
| `telemetry` | object | `{ routing_decisions: false }` | Local-only routing decision recording, disabled by default (opt-in). Enable with `takt telemetry enable` or `routing_decisions: true`; auto-routing decisions are then written as NDJSON under the project `.takt/events/` directory. TAKT does not upload routing decisions. |
| `analytics` | object | disabled | Local-only analytics collection. `enabled` turns it on, `events_path` sets a custom events directory (default `~/.takt/analytics/events`), `retention_days` sets the retention period applied by `takt purge` (default: 30 days). TAKT does not upload analytics events. |
| `workflow_mcp_servers` | object | all `false` | MCP server transport policy (`stdio`, `sse`, `http` toggles) |
| `workflow_arpeggio` | object | all `false` | Arpeggio custom code policy (`custom_data_source_modules`, `custom_merge_inline_js`, `custom_merge_files`) |
| `workflow_runtime_prepare` | object | `{ custom_scripts: false }` | Runtime prepare policy (builtin presets always allowed) |
| `workflow_command_gates` | object | `{ custom_scripts: false }` | Workflow YAML command quality gate policy |
| `workflow_overrides` | object | - | Workflow-level overrides: top-level / per-step / per-persona `quality_gates` (AI directives or `type: command` gates) and `quality_gates_edit_only` |
| `sync_conflict_resolver` | object | `{ auto_approve_tools: false }` | Sync conflict resolver policy |
| `observability` | object | disabled | Opt-in OpenTelemetry foundation. `enabled` initializes the SDK, `monitor` writes workflow metrics to `.takt/runs/<run>/monitor.json`, `session_log_exporter` writes a shadow session log from spans, and `usage_events_phase` writes phase-level usage events to `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl`. With `enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT`, TAKT also sends spans and metrics through OTLP using standard `OTEL_EXPORTER_OTLP_*` environment variables; TAKT does not add an OTLP config key. |

## Caccia Review Loop

The optional `caccia` object is accepted in both `~/.takt/config.yaml` and `.takt/config.yaml`:

```yaml
caccia:
  enabled: false          # Allow the caccia effect to wait for CodeRabbit
  wait_timeout_ms: 1800000 # Maximum wait for the initial review and each pushed commit review, in milliseconds
  max_iterations: 3       # Maximum fix-and-review iterations
  workflow: caccia        # Workflow used to judge and fix each set of threads
```

The `caccia` effect waits for CodeRabbit only when `enabled` is `true`; otherwise it returns `skipped` with `skipReason: config_disabled` immediately. The standalone `takt caccia <PR-number>` command is available regardless of this flag. Defaults are disabled, 1,800,000 milliseconds, 3 iterations, and workflow `caccia`. A project `caccia` block takes precedence over the global block; omitted fields in the selected block receive these defaults. Set `workflow` to a workflow identifier to replace the builtin workflow.

`wait_timeout_ms` bounds the initial review wait and each pushed-commit review wait, including a retry request. If a CodeRabbit rate-limit notice gives a retry time before the deadline, Caccia requests one review when that time arrives; a retry time at or beyond the deadline skips Caccia immediately. A review still incomplete at the deadline after a rate-limit notice also skips Caccia. Without a rate-limit notice, an initial timeout skips Caccia and a pushed-commit timeout is an error. The standalone command exits non-zero in either case; the system effect returns failures as `success: false` with `error` for workflow routing.

Effect progress, workflow output, results, and failures inherit the parent task's display mode and task prefix. Silent parents produce no Caccia screen output.

The merge builtins execute Caccia explicitly: `merge-review` runs `review → caccia → wait_ci → evaluation comment`, while `merge-review-fix` and `merge-review-fix-simple` run `review/fix → commit_and_push → caccia → wait_ci → merge_pr`. `success` and `skipped` continue to CI on the returned head. `limit` comments with the unresolved thread count and ends COMPLETE without merging. An effect error comments with `error` and ends ABORT. Push, task post-processing, and Pipeline no longer start Caccia implicitly. With `merge.auto_start: true`, PR publication starts the merge workflow, whose explicit effect owns Caccia.

## Project Configuration

Configure project-specific settings in `.takt/config.yaml`. This file is created when you first use TAKT in a project directory.

```yaml
# .takt/config.yaml
provider: claude-sdk              # Override provider for this project
model: sonnet                 # Override model for this project
auto_pr: true                 # Auto-create PR after worktree execution
concurrency: 2                # Parallel task count for takt run / takt watch in this project (1-10)
auto_requeue_max_attempts: 1  # Auto-requeue failed workflow tasks during takt run / takt watch (non-negative integer)
ignore_exceed: false          # Applies to takt run and takt watch like --ignore-exceed
# base_branch: main           # Base branch for clone creation (overrides global, default: remote default branch)

# Project-specific assistant settings
# assistant:
#   formal_spec:
#     mode: 'Y/n'               # Override only the global Alloy/Quint mode
#     comments: false           # Keep formal guidance, but omit forced meaning-comment instructions
#   init_files:
#     # Project config only; initial context files for interactive assistant mode
#     - docs/assistant-context.md
#     - .takt/assistant-notes.md

# Provider-specific options (legacy project defaults; runtime profiles own these options in runtime.yaml)
# codex / claude / claude_terminal / cursor / copilot / kiro / pi also support
#   guards.call_timeout_ms (60 minutes when omitted).
# provider_options:
#   codex:
#     network_access: true
#   opencode:
#     variant: high
#     skills:
#       enabled: false
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

# Provider-specific permission profiles (project-level override)
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly

```

### Pi provider settings and tool permissions

Pi runs inside the TAKT process. TAKT does not read the Pi CLI's global `settings.json`, so specify the model and thinking level in TAKT configuration.

Pi's `codemode` extension loads by default. Include `codemode` in an explicit `allowedTools` list to use it; an empty list denies all tools. The same permission mode and allowlist apply to tools called from `codemode`. These permissions do not replace an OS sandbox.

In legacy `config.yaml`, set the model and thinking level separately:

```yaml
# ~/.takt/config.yaml or .takt/config.yaml
provider: pi
model: provider/model
provider_options:
  pi:
    thinking_level: high
```

In runtime mode, set `thinking_level` in the Pi profile's `provider.profiles.<name>.options`. Workflow YAML cannot define provider, model, or provider options.

Set thinking level with `provider_options.pi.thinking_level` or `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL`. Choose `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; the default is `medium`. In `model: provider/model:high`, `:high` is part of the model ID, not a thinking level.

To migrate an older configuration that used `model: pi/...:high` to select a thinking level, remove `:high` from the model reference and set the option instead:

```yaml
provider_options:
  pi:
    thinking_level: high
```

Pi authentication uses the Pi SDK credential store or provider-native environment variables. See [Pi resource loading](#pi-resource-loading-extensions-no_) for extension and discovery settings.

### Provider inactivity deadline and OpenCode execution guards

`guards.call_timeout_ms` limits how long a provider may go without a response or tool event. Set it from 60,000 to 86,400,000 ms; the default is 3,600,000 ms (60 minutes). Each event restarts the timer, so it does not impose a 60-minute limit on the whole run. It applies to `codex`, `opencode`, Claude providers, `cursor`, `copilot`, `kiro`, and `pi`. The legacy `claude_terminal.timeout_ms` is used only when this setting is absent.

OpenCode's `provider_options.opencode.guards.profile` defaults to `standard`. `minimal` disables heuristic loop detection but retains time and output bounds. `model_profiles` is checked in order and uses `*` as a wildcard. Individual guard settings merge between global and project configuration, but a higher-priority `model_profiles` map replaces the entire lower-priority map.

OpenCode defaults to an `event_limit` of 500,000, a `text_byte_limit` of 1 MiB, and a `reasoning_byte_limit` of 4 MiB. Override `event_limit` with `TAKT_OPENCODE_STREAM_EVENT_LIMIT` if needed. During a tool call, the ordinary inactivity check pauses; if its completion event never arrives, it ends with `PART_TIMEOUT` after six times `call_timeout_ms`.

Use positive integers for limits in `guards.*` and `TAKT_PROVIDER_OPTIONS_*`. An invalid `TAKT_OPENCODE_*` temporary override falls back to its default. Remove the legacy `TAKT_OPENCODE_TOOL_ERROR_BUDGET`, `TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE`, `TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS`, `TAKT_OPENCODE_TOOL_SUCCESS_REPEATS`, and `TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS` variables and configure `guards` instead.

### Project Config Field Reference

The project's `.takt/config.yaml` can override many global settings, including `language`, `provider_routing`, and `runtime`. See the [global config field reference](#global-config-field-reference) for shared fields. Global-only fields such as `logging`, notification settings, API keys, and CLI paths cannot go in project config. The table below lists project-only fields and common overrides.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-headless"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | Override concrete provider |
| `model` | string | - | Override model name (passed to provider as-is) |
| `submodules` | `"all"` \| string[] | - | Project-only. Submodules to initialize in shared clones: `"all"` or an explicit path list (wildcards not supported) |
| `with_submodules` | boolean | - | Project-only. Legacy boolean equivalent of `submodules: "all"`; prefer `submodules` |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `caccia` | object | disabled | CodeRabbit review-loop settings; see [Caccia Review Loop](#caccia-review-loop) |
| `draft_pr` | boolean | `false` (from global) | Create the auto-created PR as a draft |
| `concurrency` | number (1-10) | `1` (from global) | Parallel task count for `takt run` / `takt watch` |
| `auto_requeue_max_attempts` | non-negative integer | `0` (from global/default) | Maximum automatic requeue attempts for failed workflow tasks during `takt run` / `takt watch`; `0` disables automatic requeue |
| `ignore_exceed` | boolean | `false` (from global/default) | Configures iteration-limit bypass for `takt run` and `takt watch`; a CLI `--ignore-exceed` flag takes precedence when specified |
| `base_branch` | string | - | Base branch for clone creation (overrides global, default: remote default branch) |
| `assistant.init_files` | string[] | - | Project-only interactive assistant initial context files. Paths must be relative to the project root; absolute paths, paths resolving outside the project root, and sensitive file patterns such as `.env*`, `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`, and `.git/**` are rejected. Missing paths, directories, and unreadable files fail with a clear error. At most 16 files are allowed; each file is limited to 256 KiB and the combined content is limited to 1 MiB. When unset or empty, TAKT does not auto-discover `CLAUDE.md`, `AGENT.md`, `AGENTS.md`, `TAKT.md`, or other files. This is separate from `takt_providers.assistant`, which only controls the assistant provider/model. |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` \| object | mode `"y/N"`, comments `true` (from global/default) | Project override for Alloy/Quint guidance that expresses requirements in both notations. The structured form accepts independent `mode`, `comments`, and `model_check_timeout_seconds` fields; `comments: false` removes only the natural-language meaning-comment instruction while retaining formal specification amount, requirement coverage, and syntax/correctness guidance. Project and global object fields resolve independently, with project values taking precedence; omitted fields fall through to the lower layer or defaults. Answers to `"Y/n"` or `"y/N"` prompts are session-local and are resolved again when a conversation is resumed; ACP and non-TTY execution never prompt and use the configured default answer. Gherkin guidance applies only to development and implementation tasks. The deprecated `assistant.gherkin` key produces a warning and is ignored without conversion, persistence, or file modification. |
| `provider_options` | object | - | Provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |
| `vcs_provider` | `"github"` \| `"gitlab"` | auto-detect | VCS provider (overrides global) |
| `takt_providers` | object | - | TAKT internal provider overrides. Project `takt_providers.assistant` overrides the global assistant provider/model and is used for assistant conversations (interactive planning, instruct on existing tasks, and retry dialogue) and Report phase fallback after an OpenCode report retry fails. If project and global assistant are both unset, Report phase fallback is disabled and top-level `provider` / `model` are not used as an implicit fallback. |
| `workflow_mcp_servers` | object | - | MCP server transport policy (overrides global) |
| `workflow_arpeggio` | object | - | Arpeggio custom code policy (overrides global) |
| `workflow_runtime_prepare` | object | - | Runtime prepare policy (overrides global) |
| `workflow_command_gates` | object | - | Workflow YAML command quality gate policy (overrides global) |
| `sync_conflict_resolver` | object | - | Sync conflict resolver policy (overrides global) |
| `observability` | object | - | Project-level OpenTelemetry opt-in override. `enabled` initializes the SDK, `monitor` writes workflow metrics to `.takt/runs/<run>/monitor.json`, `session_log_exporter` writes a shadow session log from spans, and `usage_events_phase` writes phase-level usage events to `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl`. With `enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT`, TAKT also sends spans and metrics through OTLP using standard `OTEL_EXPORTER_OTLP_*` environment variables; TAKT does not add an OTLP config key. |

Project config values override global config when both are set.

### Task Execution Config Environment Overrides

`auto_requeue_max_attempts` and `ignore_exceed` can also be set with
`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` and `TAKT_IGNORE_EXCEED`. These values use the
same config resolution order as other env-backed task execution settings:

1. Environment variable
2. Project `.takt/config.yaml`
3. Global `~/.takt/config.yaml`
4. Default

`TAKT_AUTO_REQUEUE_MAX_ATTEMPTS` must resolve to a non-negative integer after
number parsing. Non-numeric values, negative values, and non-integers fail config
validation. `TAKT_IGNORE_EXCEED` accepts only `true` or `false`; any other value
fails config validation.

## Environment Variable Overrides

Most config keys can be overridden with an environment variable named `TAKT_` plus the config key path, uppercased and joined with underscores: `logging.debug` becomes `TAKT_LOGGING_DEBUG`, `telemetry.routing_decisions` becomes `TAKT_TELEMETRY_ROUTING_DECISIONS`. Common examples: `TAKT_PROVIDER`, `TAKT_MODEL`, `TAKT_CONCURRENCY`, `TAKT_LOGGING_DEBUG`, `TAKT_TELEMETRY_ROUTING_DECISIONS`, `TAKT_OBSERVABILITY_ENABLED`. An environment value overrides the corresponding file value and is applied at the layer that owns the key: global-only keys (e.g. `logging`, `disabled_builtins`) resolve at the global `~/.takt/config.yaml` layer, while project-overridable keys (e.g. `concurrency`, `telemetry.routing_decisions`) also resolve at the project `.takt/config.yaml` layer.

Separately from config-key overrides, `TAKT_NOTIFY_WEBHOOK` sets a Slack Incoming Webhook URL. When it is set, TAKT posts a Slack notification on pipeline completion and when a `takt run` task batch finishes (run summary). Enabled manager goal notifications use the same webhook.

## Manager Notification Settings

Use `manager.notifications` in project `.takt/config.yaml` or global
`~/.takt/config.yaml` to enable or disable each kind of goal notification.

| Setting key | Event | Default |
|-------------|-------|---------|
| `question` | A question is saved | `true` |
| `awaiting_merge` | A goal awaits a human merge | `true` |
| `completed` | A goal is completed | `true` |
| `progress` | A work unit is integrated | `true` |
| `blocked` | The manager reports a blocker through the notification tool, or event handling or TUI conversation fails | `true` |
| `custom` | The manager reports another event through the notification tool | `true` |

```yaml
manager:
  notifications:
    question: true
    awaiting_merge: true
    completed: true
    progress: false
    blocked: true
    custom: true
```

Each kind resolves independently in this order: project setting → global setting →
`true`. An explicit `false` takes precedence too. For example, project
`question: true` overrides global `question: false`; omitting that key in the
project uses the global value. Settings for other kinds are unaffected.

Setting a kind to `false` disables saving, TUI notification display and Slack delivery for that kind. Answering questions, integrating results and updating goals continue, and pending questions remain visible.

Set `TAKT_NOTIFY_WEBHOOK` to deliver notifications to Slack. Enabled saved notifications refresh while the TUI is open. Failed manager event handling or TUI conversation sends `blocked`, including repeated failures. No failure-state file is created. Slack delivery failures are logged and manager work continues. These settings do not affect ordinary run or pipeline notifications.

## API Key Configuration

TAKT supports Claude, Codex, OpenCode, Pi, the official DeepSeek Harness SDK, Cursor, Copilot, and Kiro providers. Claude/Codex/OpenCode use their SDK credentials, Pi uses the Pi SDK credential store or provider environment variables, DeepSeek Harness uses the official credential store (`$DSH_HOME/.credentials.yaml`, default `~/.dsh/.credentials.yaml`) or the `DEEPSEEK_API_KEY` environment variable, Kiro uses an API key, Cursor can use either API key or existing `cursor-agent login` session, and Copilot uses a GitHub token.

The global configuration schema also retains API-key fields for some legacy or provider integrations that are not currently selectable as top-level providers. These fields do not activate a provider by themselves; use the authentication variables and keys documented for the selected provider below.

### Environment Variables (Recommended)

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...

# For OpenCode
export TAKT_OPENCODE_API_KEY=...

# For Pi
# Use the Pi SDK credential store or provider-native environment variables

# For the official DeepSeek Harness TypeScript SDK
export DEEPSEEK_API_KEY=...
# Optional: export DEEPSEEK_BASE_URL=https://...

# For Cursor Agent (optional if cursor-agent login session exists)
export TAKT_CURSOR_API_KEY=...

# For GitHub Copilot CLI
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...

# For Kiro CLI (`KIRO_API_KEY` is also accepted if TAKT_KIRO_API_KEY and kiro_api_key are unset)
export TAKT_KIRO_API_KEY=...
```

### Config File

```yaml
# ~/.takt/config.yaml
anthropic_api_key: sk-ant-...  # For Claude
openai_api_key: sk-...         # For Codex
opencode_api_key: ...          # For OpenCode
cursor_api_key: ...            # For Cursor Agent (optional)
copilot_github_token: ghp_...  # For GitHub Copilot CLI
kiro_api_key: ...              # For Kiro CLI
```

### Priority

Environment variables take precedence over `config.yaml` settings.

| Provider | Environment Variable | Config Key |
|----------|---------------------|------------|
| Claude (Anthropic) | `TAKT_ANTHROPIC_API_KEY` | `anthropic_api_key` |
| Codex (OpenAI) | `TAKT_OPENAI_API_KEY` | `openai_api_key` |
| OpenCode | `TAKT_OPENCODE_API_KEY` | `opencode_api_key` |
| Pi | Pi SDK credential store or provider-native environment variables | - |
| DeepSeek Harness | Official store `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`) or `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`) | - |
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |
| Kiro CLI | `TAKT_KIRO_API_KEY` (`KIRO_API_KEY` fallback) | `kiro_api_key` |

### Security

- If you write API keys in `config.yaml`, be careful not to commit this file to Git.
- Consider using environment variables instead.
- Add `~/.takt/config.yaml` to your global `.gitignore` if needed.
- Cursor provider can run without API key when `cursor-agent login` is already configured.
- If you set credentials, installing the corresponding CLI tool (Claude SDK, Codex, or Pi) is not necessary. TAKT directly calls the respective API. DeepSeek Harness requires `takt install deepseek-harness` and supports Linux x64/arm64 with glibc `>= 2.28` and macOS arm64 `>= 14.0`.
- TAKT passes the selected DeepSeek credential reference to the official runtime and never reads, copies, or rewrites saved credential values.
- Copilot provider requires the `copilot` CLI to be installed. The GitHub token is used for authentication.
- Kiro provider requires the `kiro-cli` CLI to be installed. `TAKT_KIRO_API_KEY` / `kiro_api_key` is passed to the child process as `KIRO_API_KEY`; if neither is set, TAKT uses the official `KIRO_API_KEY` environment variable.

### CLI Path Overrides

You can override provider CLI binary paths using environment variables or config:

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

| Provider | Environment Variable | Config Key |
|----------|---------------------|------------|
| Claude | `TAKT_CLAUDE_CLI_PATH` | `claude_cli_path` |
| Codex | `TAKT_CODEX_CLI_PATH` | `codex_cli_path` |
| Cursor Agent | `TAKT_CURSOR_CLI_PATH` | `cursor_cli_path` |
| Copilot | `TAKT_COPILOT_CLI_PATH` | `copilot_cli_path` |
| Kiro CLI | `TAKT_KIRO_CLI_PATH` | `kiro_cli_path` |

Paths must be absolute paths to executable files. Environment variables take precedence over config file values. CLI path overrides are global-only config values; set them in `~/.takt/config.yaml` or the corresponding environment variable, not project-level `.takt/config.yaml`.

## Model Resolution

Provider and model selection is owned by `runtime.yaml` when runtime mode is active, with CLI and environment overrides still available. In legacy mode, the `config.yaml` provider, model, and routing settings described below remain supported. Workflow YAML cannot select a provider or model; `provider`, `model`, and inline provider options fail at the load boundary with a migration hint.

### Provider-specific Model Notes

**Claude Code** supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). For `claude-sdk` and its `claude` alias, TAKT passes `model` through the Agent SDK model option. For `claude-headless` and `claude-terminal`, it passes the value through the CLI `--model` argument. Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

**Codex** uses the model string as-is via the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

**OpenCode** explicit model values must use `provider/model` format (e.g., `opencode/big-pickle`). Workflows require an explicit model unless resolution discards a model whose recorded provider owner differs from the selected OpenCode provider. Only in that mismatch case does TAKT ask the selected OpenCode runtime to resolve its default. Non-workflow configuration still requires an explicit model.

**Pi** accepts `provider/model` references and bare model IDs that uniquely match a configured Pi model. References are split only at `/`, so `provider/model:high` uses `model:high` as a literal model ID. Configure thinking level with `provider_options.pi.thinking_level` or `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL`; if omitted, Pi uses the SDK default `medium`. An explicitly configured level is applied on every Pi turn. If the model is omitted, TAKT keeps the Pi session's current model.

**Cursor Agent** forwards `model` directly to `cursor-agent --model <model>`. If omitted, Cursor CLI default is used.

**GitHub Copilot CLI** forwards `model` directly to `copilot --model <model>`. If omitted, Copilot CLI default is used.

**Kiro CLI** forwards `model` directly to `kiro-cli chat --model <model>`. If omitted, Kiro CLI default is used.

### Example

```yaml
# ~/.takt/config.yaml
provider: claude-sdk
model: opus     # Default model for all steps (unless overridden)
```

Workflow `promotion` entries only advance the target ladder selected in
`runtime.yaml`; they cannot contain provider, model, provider-options, or
condition fields. `capabilities` remains the workflow-level way to request
tool, network, sandbox, or skill abilities without choosing the runtime.

### OpenCode v1/v2 selection

The OpenCode provider starts the external `opencode serve` CLI and connects to its private server through an SDK. An API key alone is insufficient. The default is v2 with `@opencode/client` and `@opencode/plugin` 2.0.18. Explicit v1 selection uses `@opencode-ai/sdk` 1.18.28. Tested CLIs are v1 1.18.2 and v2 2.0.18; these are tested versions, not a guarantee of the earliest supported release. TAKT rejects a CLI whose major version differs from the selected transport before starting a server. A v1-only installation now fails unless you explicitly select v1. OpenCode v2 replaces the same `opencode` command, so TAKT never automatically switches generations or updates your CLI.

```sh
# Install v2 separately, preserving your existing CLI
npm install --prefix /path/to/opencode-v2 @opencode/cli@2.0.18
TAKT_OPENCODE_PATH=/path/to/opencode-v2/node_modules/.bin/opencode takt run
# Select a matching v1 binary to return to v1
TAKT_OPENCODE_VERSION=v1 TAKT_OPENCODE_PATH=/path/to/opencode-v1 takt run
```

These variables select the runtime for the entire TAKT process. Preserve both values in CI or your launcher. `TAKT_OPENCODE_PATH` accepts a CLI command name or path; when unset, TAKT uses `opencode` from `PATH`. Start a new run after switching generations.

In v2, the bundled plugin applies tool permissions. If the plugin is unavailable, TAKT errors before running. The tool list and permitted MCP settings you configure are used for execution. Structured output is validated against a schema after the response.

#### OpenCode Skills

Environment Skills are disabled by default in v2. Set the boolean `provider_options.opencode.skills.enabled: true` in legacy global/project configuration, a routing entry, or a workflow/step capability file to enable native Skill discovery and permissions in Phase 1. `Read` permission alone does not enable Skills. TAKT does not force native `allow`, `deny`, or `ask` to `allow`, and does not modify OpenCode configuration or Skill files.

```yaml
# Legacy ~/.takt/config.yaml or .takt/config.yaml
provider_options:
  opencode:
    skills:
      enabled: true
```

Legacy `provider_routing` also supports persona, tag, and step entries. The following entries are alternatives; keep those you need.

```yaml
provider_routing:
  personas:
    coder: { provider: opencode, provider_options: { opencode: { skills: { enabled: true } } } }
  tags:
    coding: { provider: opencode, provider_options: { opencode: { skills: { enabled: true } } } }
  steps:
    implement: { provider: opencode, provider_options: { opencode: { skills: { enabled: true } } } }
```

In runtime mode, put `skills.enabled` in the OpenCode profile's `options` and select that profile for the desired persona, tag, or step. The following targets are alternatives; keep those you need.

```yaml
version: 1
provider:
  profiles:
    default: { provider: opencode, model: opencode/big-pickle, options: { skills: { enabled: false } } }
    coder: { provider: opencode, model: opencode/big-pickle, options: { skills: { enabled: true } } }
  defaults: { profile: default }
  targets:
    personas:
      coder: { profile: coder }
    tags:
      coding: { profile: coder }
    steps:
      development-implement/implement: { profile: coder }
```

You can also set `TAKT_PROVIDER_OPTIONS_OPENCODE_SKILLS_ENABLED=true` or use `TAKT_PROVIDER_OPTIONS` JSON. The Skill tool is available only in enabled Phase 1 calls. Reports, status judgments, and read-only calls disable it; retry and resume retain the configured setting. This option does not apply to v1.

With OpenCode CLI 2.0.18, a session that enabled Skills in Phase 1 may keep a saved `<available_skills>` list in later model input even after the Skill tool is disabled. Enable Skills only for steps that need them.

For v2 MCP servers, TAKT waits up to 30 seconds for allowed tools to register. A server without a tool limit must register at least one tool.


## Runtime Provider Configuration (runtime.yaml)

`runtime.yaml` keeps provider/model/options out of your workflows so the same workflow can run in different execution environments without edits. It is read from two fixed paths, with the project file taking priority over the global one:

1. `~/.takt/runtime.yaml`
2. `<project>/.takt/runtime.yaml`

Companion reviewers are disabled by default. Enable them with the top-level
`companion.enabled` policy:

```yaml
version: 1
companion:
  enabled: true
  review_mode: completion # completion | live
  fix_policy: single      # single | loop
```

The `companion` policy must specify at least one of `enabled`, `review_mode`, or `fix_policy`.
A mode-only or fix-policy-only policy such as `companion: { review_mode: live }` or
`companion: { fix_policy: loop }` is accepted and resolves to `enabled: false`;
an empty `companion: {}` policy is rejected.

When both global and project policies are specified, their `enabled` values are combined
with logical AND; a project value of `true` cannot re-enable a globally disabled
companion. An omitted policy is neutral during layer merging, and Companion
remains disabled when neither layer specifies one.

`companion.review_mode` defaults to `completion`. The project value overrides the
global value, and a project omission inherits the global value. `completion`
reviews the cumulative diff after a successful implementer response; `live`
preserves quiet, forced, and commit-triggered reviews during the response. Only
`completion` and `live` are accepted, and invalid values fail while loading
`runtime.yaml`. The mode and fix policy are validated even when `companion.enabled`
is `false`, but no Companion provider is resolved or executed in that case.

`companion.fix_policy` defaults to `single`. The project value overrides the
global value, and a project omission inherits the global value. `single` performs
at most one advisory fix follow-up after the initial review and does not re-review
the follow-up; `loop` preserves the repeated review-and-fix behavior. Only `single`
and `loop` are accepted, and invalid values fail while loading `runtime.yaml`.

Companion provider targets (`targets.companions`) and provider capability
requirements apply only while companions are enabled. When disabled, companion
declarations and the structural validation of `targets.companions` remain in
place, but no companion provider is resolved or executed — a workflow that
declares companions runs without any companion provider configuration.

### Post-run loop analysis

Loop analysis is opt-in. Add the top-level `loop_analysis` section to analyze
completed runs after their terminal artifacts have been finalized:

```yaml
version: 1
loop_analysis:
  enabled: true
  output: file # file | pr-comment; defaults to file
```

When enabled, analysis starts after a successful, failed, or interrupted run ends. The source run does not wait for it, and analysis failure does not change the source result. If the process is forcibly stopped just after the run ends, analysis may not start.

Analysis reads logs, traces, reports, and workflow definitions to identify repeated problems and suggest improvements. Find the result in the analysis run's `reports/loop-analysis.md`. A complete copy is saved under `loop-analysis/` in `TAKT_CONFIG_DIR` (or `~/.takt` by default). Recognized secrets, local paths, and similar details are removed from the published report.

With `output: pr-comment`, TAKT comments on an existing PR when auto-PR was enabled for the source run. Without a PR, the report remains in files. Assign the analysis provider with the usual `runtime.yaml` target. If both global and project files set `loop_analysis`, the project section takes precedence.

Runtime mode is enabled by the presence of an active `provider` section, not by the file existing. A file that only contains `version: 1` is inactive and leaves the legacy `config.yaml` provider resolution in place.

### Configuration example

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
      manager-permission-judge:
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

### Named assignments

`provider.assignments` defines named provider configuration sets that can be selected for a
project directory or with `--runtime-assignment <name>`. Each entry must contain `defaults` or `targets`; an empty assignment is not
valid. `defaults` has the same shape as top-level `provider.defaults` and must choose exactly one
of `profile` or `ladder`. `targets` has the same shape as top-level `provider.targets`:
`personas`, `tags`, and `steps` may use `profile`, `pool`, or `ladder`; `internal_agents` may use
`profile` or `ladder`, while `companions` may use only a fixed `profile`.

`provider.directories` maps a directory path to an assignment name. The lookup target is the
startup project directory. Keys expand `~`, become absolute, and then receive realpath-equivalent
normalization for existing paths before exact comparison. Prefix matching and globs are not used.
An unknown assignment name in this map fails fast while loading. When a directory matches, the
assignment's `defaults` are used; if omitted, top-level `provider.defaults` is used. If the
assignment has `targets`, it replaces the entire top-level `provider.targets` map; individual
target maps are not merged. An assignment that omits `targets` keeps the top-level
`provider.targets`. `profiles` and `auto_routing` remain shared.

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

Across global and project layers, `assignments` follow the profile rule: a same-name project
entry replaces the global entry wholesale, while differently named entries coexist. For
`directories`, project wins when normalized keys are equal and otherwise both mappings remain.
These merges happen before directory assignment selection. Profile, pool, and ladder references
inside assignments are validated with the other runtime provider references and fail fast before
an agent runs.

#### Select a preset for an invocation

`--runtime-assignment <name>` selects from `provider.assignments` after global and project
runtime files are merged. It takes precedence over a matching `provider.directories` entry.
The assignment is applied once to the merged top-level settings: omitted `defaults` or `targets`
inherit the top-level value, and supplied `targets` replace the entire map. `profiles`,
`auto_routing`, `mcp`, `companion`, and `loop_analysis` stay shared. Existing `--provider`,
`--model`, and `--auto-strategy` overrides retain their priority above the selected settings.

Share profiles and cost/quality presets in the project's `.takt/runtime.yaml`:

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

In this example, `cost` uses low effort by default and medium effort for the reviewer.
`quality` uses high effort by default and inherits the top-level reviewer target.

The option applies to interactive startup, direct execution, pipeline, `run`, `watch`, and
other subcommands. All tasks in one `run`, tasks added later to the same `watch`, internal
agents, and loop-analysis use the same selection. Selection does not write configuration
files or add a field to task records; requeue, retry, and instruct do not restore a past
invocation's choice. Ordinary task execution still updates task status. Without the option,
existing directory matching and top-level resolution are unchanged.

An unknown name, missing assignments, or no active runtime provider section stops before
any agent starts. The error includes the requested name and available assignment names,
or states that none are defined. TAKT does not fall back to the directory or legacy settings.

A member can add a differently named assignment to their `~/.takt/runtime.yaml` and select it
alongside project presets. For example:

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

Differently named profiles and assignments from both layers survive the merge; a same-name
project entry replaces the global entry entirely.

Define named provider, model, and options combinations under `provider.profiles`. `capabilities` can name a provider-options preset, resolved project → global → builtin; a profile's `options` take precedence. Add `permission_mode` if needed, or `extends` to inherit another profile. A project profile replaces a same-named global profile in full.

To restrict an internal agent's permissions, assign a profile with `capabilities` or `permission_mode`. Without either, normal provider settings apply.

`provider.defaults` is required in every active provider section and must choose exactly one of a fixed `profile` or an ordered `ladder`. It cannot specify `pool`. Entries under `provider.targets.personas`, `provider.targets.tags`, and `provider.targets.steps` choose exactly one of a fixed `profile`, an ordered `ladder`, or an auto-routing `pool`; `pool` is valid only on these explicit workflow targets. `internal_agents` entries may use a fixed `profile` or an ordered `ladder`, but cannot use `pool`. `companions` entries must use a fixed `profile` and cannot use `pool` or `ladder`. Steps are named `<leaf-workflow-name>/<step-name>`; control nodes that do not run an agent (such as `workflow_call`) are not resolution targets.

Set `pool` on targets that should use auto routing. Other targets and operations outside workflows use `provider.defaults`. A selected pool uses its own `fallback_profile`.

### Resolution priority

A workflow agent's provider is resolved by this ladder, later entries overriding earlier ones:

```text
defaults
  < personas
  < tags
  < steps
```

The internal `selector`, `assistant`, `loop-judge`, `review-completion-judge`, and `manager-permission-judge` agents resolve through a separate ladder. `selector` chooses dynamic work, `assistant` backs interactive sessions, `loop-judge` evaluates loop monitors, and `review-completion-judge` decides whether an opted-in reviewer needs another pass. `manager-permission-judge` reviews tool use before execution in manager conversations with the claude (claude-sdk) or codex provider. Set its provider and model through `provider.targets.internal_agents.manager-permission-judge` in `runtime.yaml`, using `profile` or `ladder`; `pool` is not allowed. Every seat is optional; an unassigned seat uses the ordinary default resolution. However, an unassigned `manager-permission-judge` seat uses the same provider, model, and provider options as the manager.

```text
defaults
  < internal_agents.<agent>
```

When two targets at the same priority (for example two matching tags) assign different providers, resolution fails fast instead of picking one silently. Explicit `--provider` / `--model` on the command line are runtime overrides and are allowed in both legacy and runtime modes.

Auto routing candidates reference `provider.profiles` instead of repeating provider/model/options, and the router references a profile through `router_profile`. Pool, tier, and other routing metadata belong to `provider.auto_routing`. A parse/schema mismatch from the router or an unknown profile reference fails fast before any agent runs rather than being hidden behind a fallback.

### Migration from legacy config.yaml

Runtime and legacy provider settings must not be mixed. Move each legacy setting to its runtime destination:

| Legacy setting | Runtime destination |
|---|---|
| `provider` / `model` | a profile referenced by `provider.defaults` |
| `provider_options` | `provider.profiles.*.options` |
| `provider_routing.personas` | `provider.targets.personas` |
| `provider_routing.tags` | `provider.targets.tags` |
| `provider_routing.steps` | `provider.targets.steps` |
| `persona_providers` | `provider.targets.personas` |
| `takt_providers.selector` / `takt_providers.assistant` | `provider.targets.internal_agents` |
| `auto_routing` | `provider.auto_routing` |
| auto routing candidates | pool candidates that reference `provider.profiles` |
| workflow-level provider settings | `provider.targets.steps` |

### Mixed configuration error

If an active `runtime.yaml` provider section coexists with any legacy provider setting, TAKT stops before running an agent and reports each location together with its migration target:

```text
Mixed provider configuration detected: an active runtime.yaml provider section cannot
coexist with legacy provider settings. Remove the runtime.yaml provider section or migrate
the following legacy settings:
  - provider at config.yaml:provider (global) → migrate to provider.defaults + provider.profiles
  - provider_routing at config.yaml:provider_routing → migrate to provider.targets
```

### First-run generation

On first launch TAKT generates `~/.takt/runtime.yaml` atomically and never overwrites an existing file; the project `.takt/runtime.yaml` is never generated automatically. A fresh environment is written with the selected provider/model as `provider.profiles.default` plus `provider.defaults.profile: default`. An environment that already has legacy provider settings receives only an inactive `version: 1` file, so its behavior does not change until you migrate.

## Runtime MCP Configuration in `runtime.yaml`

The `mcp` section in `runtime.yaml` defines MCP servers and assigns them to agents. It sits alongside `provider` at the top level and can be active without a `provider` section. In that case, provider/model resolution continues through legacy `config.yaml` while MCP servers are injected.

### Configuration example

```yaml
version: 1

mcp:
  servers:
    common-tools:
      type: stdio
      command: common-mcp-server
      args: []
      env:
        API_TOKEN: "${COMMON_MCP_API_TOKEN}"
    github:
      type: http
      url: https://api.githubcopilot.com/mcp/
      headers:
        Authorization: "Bearer ${GITHUB_TOKEN}"

  defaults:
    servers:
      - common-tools

  targets:
    personas:
      release-manager:
        servers:
          - github
    tags:
      github:
        servers:
          - github
    steps:
      release/create-pr:
        servers:
          - github
    internal_agents:
      selector:
        exclude:
          - common-tools
```

### Schema

| Field | Type | Description |
|---|---|---|
| `mcp.servers` | `{ <name>: ServerEntry }` | Named MCP server definitions (`stdio` / `sse` / `http`). Defining a server here alone does not enable it — it must be assigned through `defaults` or `targets`. |
| `mcp.defaults.servers` | `string[]` | Servers applied to every agent execution (normal steps, parallel agents, fan-in, internal agents, sub-workflow leaf steps). |
| `mcp.targets.personas` | `{ <persona>: { servers?, exclude? } }` | Per-persona additions/exclusions. |
| `mcp.targets.tags` | `{ <tag>: { servers?, exclude? } }` | Per-tag additions/exclusions. |
| `mcp.targets.steps` | `{ <leaf-workflow>/<step>: { servers?, exclude? } }` | Per-step additions/exclusions. Control nodes (`workflow_call` etc.) are not resolution targets. |
| `mcp.targets.internal_agents` | `{ selector: { exclude? } }` | Exclusions applied to internal agents (`selector`, `assistant`, and `manager`). Only `selector.exclude` is accepted. Manager also matches `mcp.targets.personas.manager`; its own TAKT MCP server is always added. |

Server entries:

| Transport | Required fields | Optional fields |
|---|---|---|
| `stdio` | `command` | `args`, `env` |
| `sse` | `url` | `headers` |
| `http` | `url` | `headers` |

### Effective server resolution

```text
effective servers
  = defaults.servers
  + matched targets.servers
  - matched targets.exclude
```

- Server names are de-duplicated.
- `exclude` takes priority over additions.
- A `targets` entry referencing an unknown server name fails fast before any agent runs.
- `mcp.servers` definitions alone do not enable a server; it must be assigned through `defaults` or `targets`.

### Global/project merge

When both the global and project `runtime.yaml` carry an `mcp` section, the project section replaces the global one wholesale — same-name servers are not field-merged, and `defaults`/`targets` take the project value when present. This mirrors the `provider` section merge rule.

### Environment variable interpolation

`${NAME}` references in `command`, `args`, `env`, `url`, and `headers` are resolved against `process.env` before agent startup. An undefined required environment variable fails fast; TAKT never silently substitutes an empty string. Resolved secret values (env, headers) are never written to logs or error messages.

### Provider transport compatibility

Each provider declares the transports it supports. When a resolved server uses an unsupported transport, TAKT fails fast before agent startup and reports the provider, server, transport, supported transports, and the runtime.yaml source path.

| Provider | Supported transports |
|---|---|
| `claude-sdk` / `claude` / `claude-headless` / `claude-terminal` | `stdio`, `sse`, `http` |
| `codex` | `stdio`, `http` |
| `opencode` | `stdio`, `http` |
| `cursor` | `stdio`, `http` |
| `copilot` | `stdio`, `http` |
| `kiro` | `stdio`, `http` |
| `mock` | `stdio` |

Incompatible transports are never silently converted to another transport, and servers are never silently dropped.

### Legacy workflow MCP mode and migration

MCP configuration also must not be mixed across the legacy and runtime modes:

- No active `mcp` section in `runtime.yaml`: the workflow `mcp_servers` and `workflow_mcp_servers` policy are used.
- Active `mcp` section in `runtime.yaml`: only the runtime MCP assignment is used.
- Runtime MCP and workflow `mcp_servers` coexisting: TAKT fails fast, naming the workflow/step and the migration target.

In runtime MCP mode, workflows cannot specify MCP server command, URL, header, or env — those belong to the `mcp` section in `runtime.yaml`.

| Legacy setting | Runtime destination |
|---|---|
| workflow `mcp_servers` policy | `mcp.targets` |
| step `mcp_servers` map | `mcp.targets.steps` |

## Provider Profiles

Provider profiles allow you to set default permission modes and per-step permission overrides for each provider. This is useful when running different providers with different security postures.

### Permission Modes

TAKT uses three provider-independent permission modes:

| Mode | Description | Claude | Codex | OpenCode | Pi | DeepSeek Harness | Cursor Agent | Copilot | Kiro CLI |
|------|-------------|--------|-------|----------|----|-----------------|--------------|---------|----------|
| `readonly` | Read-only access, no file modifications | `default` | `read-only` | `read-only` | `read`, `grep`, `find`, `ls`, `codemode` | Not exposed by this SDK | default flags (no `--force`) | no permission flags | `--trust-tools=read,grep` |
| `edit` | Allow file edits with confirmation | `acceptEdits` | `workspace-write` | `workspace-write` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, `codemode` | Not exposed by this SDK | default flags (no `--force`) | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | Bypass all permission checks | `bypassPermissions` | `danger-full-access` | `danger-full-access` | all registered Pi tools | Not exposed by this SDK | `--force` | `--yolo` | `--trust-all-tools` |

Pi permission modes are SDK active-tool allowlists, not an operating-system sandbox, and TAKT does not add per-tool confirmation prompts for Pi. In particular, Pi `edit` enables `bash`, and Pi's file tools can accept absolute paths. Run Pi with trusted workflow input and extensions. If an internal-agent role needs narrower authority, configure capabilities and a permission mode on its Pi profile.

### Configuration

Provider profiles can be set at both global and project levels:

```yaml
# ~/.takt/config.yaml (global) or .takt/config.yaml (project)
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

### Permission Resolution Priority

Permission mode is resolved in the following order (first match wins):

1. **Project** `provider_profiles.<provider>.step_permission_overrides.<step>`
2. **Global** `provider_profiles.<provider>.step_permission_overrides.<step>`
3. **Project** `provider_profiles.<provider>.default_permission_mode`
4. **Global** `provider_profiles.<provider>.default_permission_mode`
5. **Step** `required_permission_mode` (acts as a minimum floor)

The `required_permission_mode` on a step sets the minimum floor. If the resolved mode from provider profiles is lower than the required mode, the required mode is used instead. For example, if a step requires `edit` but the profile resolves to `readonly`, the effective mode will be `edit`.

Every provider also has a builtin `default_permission_mode: edit` that always participates in this resolution. When neither project nor global `provider_profiles` set a value, the effective mode is therefore `edit` (raised when the step's `required_permission_mode` demands more).

Provider permission profile keys match the selected provider name; they are not aliases. When using the new `claude-sdk` default or explicit `claude-sdk`, move existing `provider_profiles.claude` settings to `provider_profiles.claude-sdk`. Explicit `claude` still uses the `claude` key; `claude-headless` uses `claude-headless`. If the provider is omitted, an old `claude` profile specifying `readonly` no longer applies and the SDK can fall back to builtin `edit` unless the profile is moved.

### Legacy `config.yaml` Provider Routing

When runtime mode is inactive, `provider_routing` can route workflow steps to
different providers, models, and provider-specific options without duplicating
workflows. This existing legacy path can be defined in either
`~/.takt/config.yaml` or `.takt/config.yaml`; runtime mode uses
`provider.targets` instead (see [Runtime Provider Configuration](#runtime-provider-configuration-runtimeyaml)).

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

`provider_routing.personas` uses the raw `persona` key from the workflow step, so `persona_name` is display-only and does not affect routing. `provider_routing.tags` applies entries matching the step's `tags`; when multiple tags match, TAKT applies them in the order written on the step, and later tags override the same provider/model/provider_options leaf. `provider_routing.steps` uses the workflow step `name`. In an active runtime configuration, these routing keys are rejected as mixed legacy settings; move them to `provider.targets`.

Each routing entry can include `provider`, `model`, and/or `provider_options`. Those fields are individually optional, but each entry must include at least one of them. Empty `provider_options` objects are rejected.

In legacy mode, the workflow-step resolution priority is:

```text
explicit CLI / environment override
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # deprecated legacy
> effective auto_routing (auto.rules / auto.dynamic / auto.fallback)
> project .takt/config.yaml
> global ~/.takt/config.yaml
> provider default
```

Provider selection follows the priority above. Model selection uses the first layer that specifies a model. If that same entry also specifies a provider, TAKT uses the model only when that provider matches the selected provider. On a mismatch, TAKT leaves the model unset and does not try lower-priority model entries. A model-only entry is passed through unchanged.

Workflow YAML has no provider/model layer. An assigned runtime `internal_agents`
seat resolves synthetic engine steps independently, and workflow promotion only
advances its runtime target ladder.

### Auto Routing

In legacy mode, define `auto_routing` in project `.takt/config.yaml` or
global `~/.takt/config.yaml` when TAKT should choose both provider and model
from a candidate list. In runtime mode, use `provider.auto_routing` and target
profiles in `runtime.yaml`; workflow YAML cannot enable or override auto
routing. Keep a concrete top-level provider/model in legacy config for
operations outside workflow steps.

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

In legacy mode, the top-level `provider` and `model` are the defaults. Set a provider and model for each `auto_routing.candidates` entry. Automatic selection applies to workflow steps; operations outside steps use the top-level settings.

Assistant conversations (interactive planning, instruct on existing tasks, and retry dialogue) do not go through auto routing. They resolve `takt_providers.assistant`, then fall back to the top-level provider/model when the assistant setting is unset; the assistant setting is not a default for other internal operations. CLI `--provider` / `--model` overrides apply to interactive planning only, while instruct and retry do not accept those overrides. Without a resolvable assistant or top-level provider, assistant startup fails with `Provider is not configured.`

In runtime mode, `provider.defaults` selects the default profile or ladder. Set a pool on targets that use auto routing; pool candidates reference `provider.profiles`. Hard rules for pool selection run in `tags`, `steps`, `personas` order. Provider targets themselves have precedence `defaults < personas < tags < steps`. Without a matching hard rule, `pool_rules` and the router's tier choose a candidate.

Candidate `routing_tier` is limited to `high`, `medium`, or `low`. Runtime
profiles carry provider/model/options, so candidates reference profiles rather
than repeating those fields. CLI can override the strategy with
`--auto-strategy cost|balanced|performance`; the override is propagated until
execution reaches a runtime auto-routing target.

Routing decisions are local-only telemetry and are not recorded by default. When `telemetry.routing_decisions` is enabled (`takt telemetry enable` or `routing_decisions: true`), TAKT writes them as NDJSON under the project `.takt/events/` directory. TAKT does not upload routing decisions. Use `takt telemetry status`, `takt telemetry enable`, and `takt telemetry disable` to inspect or change only this local recording setting.

Provider options resolve from runtime profiles, capability presets, config, and environment variables. Workflow YAML cannot define them directly. Preview, doctor, validation, summary, and report use the same settings as execution.

`provider_options` resolve per leaf. Runtime mode uses profile options and rejects `provider_options` in workflow YAML. In legacy `config.yaml` mode, environment- or CLI-sourced configuration normally takes precedence. The `base_url` exception resolves in this order: `provider_routing.steps` → `provider_routing.tags` → `provider_routing.personas` → deprecated `persona_providers` → project `.takt/config.yaml` → global `~/.takt/config.yaml` → TAKT environment override. Preview, doctor, validation, summary, and report use the same resolution as workflow execution.

Project `.takt/config.yaml` may set `base_url` only to loopback hosts such as `127.0.0.1`, `127.x.x.x`, `localhost`, `*.localhost`, or `::1`. Put external provider base URLs in user-controlled global config or `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` / `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL` / `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL`.

`persona_providers` is still supported for existing configs, but it is deprecated for new settings. It uses the step's persona display name, which may come from `persona_name`, not necessarily the raw `persona` key:

```yaml
persona_providers:
  implementation-coder:
    provider: codex
    model: gpt-5
    provider_options:
      codex:
        reasoning_effort: high
```

Capability references can load shared provider-options presets by name. Names are resolved first-match from `.takt/provider-options`, then `~/.takt/provider-options`, then `builtins/{lang}/provider-options`. For workflows installed from a repertoire package, the package-local `provider-options/` directory is checked before those locations. A scoped ref such as `@owner/repo/name` resolves `name` from another repertoire package's `provider-options/` directory. Workflow YAML may reference only capability presets; provider/model/options definitions belong in runtime profiles (or the retained legacy config layers).

Capability preset resolution fails fast as a configuration error when a preset or path cannot be resolved, a scoped ref points to an unavailable repertoire package, the target YAML is invalid or is not a provider-options object, the extends chain is circular, or the removed `$ref` key is used. Relative paths are resolved from the workflow file and must stay inside the workflow directory after symlink resolution; absolute paths and paths whose real target escapes that directory are rejected.

Provider options can also be set with the corresponding `TAKT_PROVIDER_OPTIONS_*` environment variables. Examples:

| Setting | Environment variable examples |
|---|---|
| OpenCode model variant | `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` |
| Codex, Claude, and DeepSeek base URLs | `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1`, `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787`, `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL=http://127.0.0.1:8787/v1` |
| Codex permissions and Skills | `TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL=codex`, `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_REPO=true`, `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_USER=true` |
| Claude Skills | `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED=true` |
| Claude terminal | `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500` |
| Kiro agent | `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` |
| Pi thinking and resources | `TAKT_PROVIDER_OPTIONS_PI_THINKING_LEVEL=high`, `TAKT_PROVIDER_OPTIONS_PI_EXTENSIONS='["npm:pi-fff"]'`, `TAKT_PROVIDER_OPTIONS_PI_NO_EXTENSIONS=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_SKILLS=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_PROMPT_TEMPLATES=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_THEMES=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_CONTEXT_FILES=true` |
| Pi system prompt | `TAKT_PROVIDER_OPTIONS_PI_SYSTEM_PROMPT_MODE=append` or `replace` |

In legacy `config.yaml` mode, `provider_routing` takes precedence over environment variables for `base_url`.

Runtime targets let you select a provider and model for each step in the same workflow.

The provider-specific examples below use the legacy `config.yaml` option bag
for compatibility. In runtime mode, put execution options under
`provider.profiles.<name>.options` in `runtime.yaml`; use workflow
`capabilities` only for the supported ability leaves.

### Provider-specific options in practice

#### Provider base URL (`base_url`)

Use `base_url` to route supported providers through an OpenAI-compatible or Anthropic-compatible proxy:

```yaml
provider_options:
  claude:
    base_url: http://127.0.0.1:8787
  codex:
    base_url: http://127.0.0.1:8787/v1
```

`base_url` works with Claude SDK providers (`claude-sdk`, `claude`, `claude-headless`), Codex, and DeepSeek Harness. TAKT's `provider_options.*.base_url` takes precedence over each provider's `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or `DEEPSEEK_BASE_URL` environment variable.

Project config accepts local loopback addresses only. Set external proxies or gateways in global config or the corresponding `TAKT_PROVIDER_OPTIONS_*_BASE_URL` variable.

#### DeepSeek Harness (`deepseek-harness`)

DeepSeek Harness uses the official TypeScript SDK and runtime. Run `takt install deepseek-harness` before using it. The SDK installs under TAKT's managed directory (by default `~/.takt/deepseek-harness/sdk`). Supported platforms are Linux x64/arm64 with glibc `>= 2.28` and macOS arm64 `>= 14.0`. If an installation is damaged, reinstall with `takt install deepseek-harness --force`.

```yaml
provider: deepseek-harness
model: deepseek-v4-flash
provider_options:
  deepseek_harness:
    base_url: http://127.0.0.1:8787/v1
    max_tokens: 4096
    request_timeout_ms: 3600000
    shutdown_timeout_ms: 1000
    plugins:
      - npm:@example/cordis-plugin@1.2.3
      - source: npm:another-cordis-plugin@2.0.0
        id: another-plugin
        config:
          enabled: true
      - id: example-plugin
        source: git:https://github.com/example/plugin.git
        ref: v1.2.3
        config:
          enabled: true
```

Define `plugins` in global configuration (`~/.takt/config.yaml`) or trusted global runtime profiles, not in project or workflow configuration. A user-controlled `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PLUGINS` JSON array can also supply plugin options. Project-defined plugins are rejected; an empty list may disable plugins. Plugins execute with the runtime's permissions and may access credentials, so load only code you trust. Plugin `config` values are hidden in previews, session logs, and telemetry, without changing the values supplied to the runtime.

DeepSeek Harness plugins can be loaded from npm packages or Git HTTPS/SSH repositories. Use `npm:<package-spec>` as a string or as the `source` in an object; `id` and `config` are optional. TAKT installs npm packages into temporary directories without running lifecycle scripts, resolves the package `exports` or `main` entrypoint, and removes the temporary files when the runtime ends. npm plugins execute with the runtime's permissions and may access credentials. Only use packages whose code you trust. Pin package versions to fix the top-level package tarball; this alone does not guarantee reproducible dependency resolution. TAKT installs with `--package-lock=false`, so ranged transitive dependencies may resolve to different versions between runs unless the published package includes an appropriate `npm-shrinkwrap.json`. URLs containing credentials or sensitive query parameters are rejected before npm starts; use protected npm configuration for authentication instead. Git sources retain their existing behavior: plaintext `http://` and `git://` sources are rejected. Use `git:` before a Git URL when desired; set `ref` to a tag, branch, or commit. Pin a tag or commit to select a Git source revision. This alone does not guarantee reproducible dependency resolution: when the repository has a `package.json`, TAKT installs dependencies with `npm install --package-lock=false`, so resolved dependency versions may vary between runs. Omitting `ref` uses the repository's default revision and emits a warning. Lifecycle scripts are not run. Private repositories use the existing SSH keys or Git credential helper; SSH sources may use the conventional `git` username, but must not embed passwords, tokens, or secrets. Other credential-bearing URLs are rejected before Git is run. Git and askpass prompts are disabled; default SSH uses batch mode. Configure working credentials and trusted host keys before running TAKT. An existing custom SSH command or executable is preserved.

If the official runtime reports that a configured npm plugin did not activate, TAKT stops that provider call and reports an actionable entrypoint/configuration hint without forwarding raw plugin diagnostics.

`base_url` is optional. Project config accepts loopback addresses only; set an external endpoint in global config or `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL`. TAKT's `base_url` setting takes precedence over the provider-native `DEEPSEEK_BASE_URL`.

Use the official credential store at `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`) or an environment variable. Set the variable name with `llm-deepseek.apiKeyEnv` in `$DSH_HOME/settings.yaml`; the default is `DEEPSEEK_API_KEY`. The selected environment variable takes precedence over the stored credential. If the store sets `llm-deepseek.baseURL`, it must match the endpoint in use. Preserve an existing store and start a new TAKT session or run after installation.

You can continue a session while the same runtime remains active and the model, credentials, and runtime settings stay the same. The SDK cannot restore conversation history after the runtime ends or settings change. In interactive mode, start a new session on the next user turn; in a workflow, start a new TAKT session or run. Changing the credential source or endpoint also requires a new session or run.

The DeepSeek SDK can use file, search, shell, and subagent tools. Its workspace-write boundary limits writes but does not isolate secret-file reads. Run it in a trusted workspace. TAKT disables the SDK's session-file persistence and session-log API upload.

The SDK does not support permission modes or callbacks, `bypassPermissions`, an explicit allowed-tools list, a nonempty MCP server map, `maxTurns`, structured output, or image attachments. Steps that require these fail before execution. Tool-free report or status phases also cannot use this provider; choose a provider that supports those controls.

When migrating from the old Python/uv version, remove `runtime_mode`, Python/uv-only options, `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_RUNTIME_MODE`, and `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PYTHON_PATH` from configuration. Use `takt install deepseek-harness`. Before manually removing old `venv/`, `pyproject.toml`, or `uv.lock` files, stop all TAKT/DeepSeek processes, back up needed data, and confirm they belong to the old environment. Keep the `$DSH_HOME` credential store and current `deepseek-harness/sdk`, `state/`, `dsh-home/`, and `install.lock`.

If another TAKT process is using a runtime in the same managed directory, wait for it to exit or use a separate `TAKT_CONFIG_DIR`. If startup is blocked after an abnormal exit, confirm that the old runtime, supervisor, and tool processes have all ended. Only then manually clear `.runtime-state-lock` and `cleanup-blocked` under `deepseek-harness/state/`.

#### Network access (`network_access`)

When an implementation step runs network-dependent commands such as `npm install` / `pip install` / `gradle` / `mvn`, provider sandboxes block network by default and the command fails. Configure each provider as follows.

Codex blocks network by default. Enable it with:

```yaml
provider_options:
  codex:
    network_access: true
```

OpenCode does not have a native sandbox. TAKT controls `webfetch` / `websearch` tool permissions as an abstraction layer behind the same key:

```yaml
provider_options:
  opencode:
    network_access: true
```

OpenCode tool allowlists use lowercase OpenCode tool names:

```yaml
provider_options:
  opencode:
    allowed_tools: [read, glob, grep, bash, websearch, webfetch]
```

`network_access` can be set by a runtime profile or capability preset. In
legacy mode it can also be set through `provider_routing`, deprecated
`persona_providers`, project, or global config. The environment variable
`TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS=true` also works as an override.

#### Codex fast mode (`fast_mode`)

Set the optional Codex fast-mode feature explicitly with `provider_options.codex.fast_mode`:

```yaml
provider_options:
  codex:
    fast_mode: true
```

Both `true` and `false` are explicit values. If the setting is omitted, TAKT does not send
`features.fast_mode` to Codex and Codex keeps its own default. The environment override is
`TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE=true` or `TAKT_PROVIDER_OPTIONS_CODEX_FAST_MODE=false`.

Set it in a runtime profile, legacy `provider_routing`, project or global `provider_options`, or an environment variable. `takt exec` uses the selected runtime default.

#### Codex permission control (`permission_control`)

Codex uses TAKT's permission mode mapping by default. This is equivalent to `permission_control: takt` and passes the resolved TAKT `permission_mode` to the Codex SDK as `sandboxMode`. `network_access`, when set, is also passed as `networkAccessEnabled`; when omitted, Codex keeps its default (`false`).

To delegate permission control to Codex, explicitly opt in:

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

With `permission_control: codex`, Codex settings control sandbox and network permissions. TAKT's `network_access` setting does not affect effective Codex permissions in this mode. TAKT still sets `approvalPolicy: never` for non-interactive runs, so check the Codex configuration you use. `reasoning_effort`, `fast_mode`, and `skills` continue to apply.

To select a named Codex configuration profile, add `config_profile` alongside `permission_control: codex`:

```yaml
provider_options:
  codex:
    permission_control: codex
    config_profile: automation-review
```

`config_profile` accepts a name made of ASCII letters, digits, hyphens, and underscores. Use it with `permission_control: codex` in a runtime profile or legacy project or global config. TAKT passes `codex exec --profile <name>`, and Codex reads `$CODEX_HOME/<name>.config.toml`. Check that profile's contents, including permissions, before using it.

#### Codex Skill inheritance (`skills`)

TAKT workflows do not inherit repository or user Codex Skills by default. Enable either scope explicitly with a runtime profile or the `enable-skills` capability when a workflow should use those environment-dependent instructions. `takt exec` keeps the resolved capability in its generated workflow, while provider/model/options remain in runtime configuration. A `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_*` environment override supplied to a later invocation remains higher priority.

```yaml
provider_options:
  codex:
    skills:
      repo: true
      user: false
```

- `repo` covers `.agents/skills` directories from the Codex execution CWD through the repository root.
- `user` covers `$HOME/.agents/skills` and the compatibility location `$CODEX_HOME/skills`. The `.system` directory below the compatibility location is excluded.
- `false` discovers each `SKILL.md` in that scope, resolves symlinks to absolute paths, removes duplicates, and passes an exact `enabled: false` override to the Codex process.
- `true` passes no enable override for that scope, so Codex's standard behavior and existing user configuration remain in effect.

Discovery uses the same depth, directory, and entry limits as Codex. If a scan exceeds a limit, TAKT fails the provider call instead of applying a partial deny list. These settings do not modify the user's Codex config. ADMIN, SYSTEM, and Plugin Skills are outside their discovery roots and retain Codex's standard behavior. The settings use the normal provider-option leaf priority and apply unchanged to retries and resumed sessions.

#### Claude Skill inheritance (`skills`)

TAKT disables filesystem Skill discovery for `claude-sdk`, `claude`, `claude-headless`, and `claude-terminal` by default. Enable it only when a workflow intentionally depends on repository or user Skills:

```yaml
provider_options:
  claude:
    skills:
      enabled: true
```

With `enabled: false`, `claude-sdk` and its `claude` alias receive `skills: []`; `claude-headless` and `claude-terminal` receive `--disable-slash-commands`. This also disables custom Claude slash commands for those CLI sessions. With `enabled: true`, TAKT adds no Skill option or flag, preserving Claude's normal discovery. The setting follows normal provider-option leaf priority, including `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED`, and is retained for retries and resumed sessions.

This is a context filter, not a sandbox: a Skill file can still be reachable through Read or Bash. TAKT does not change `settingSources`, Claude settings, or user/repository Skill files. The pinned Agent SDK version for managed installation is `0.3.300`. CLI sessions require a Claude Code version that supports `--disable-slash-commands`; TAKT verifies the flag before starting either a headless (`claude-headless`) or terminal (`claude-terminal`) CLI session and reports an update error when unavailable. Claude Code `2.1.220` is the verified minimum.

#### Claude Code sandbox control (`allow_unsandboxed_commands`)

With `permission_mode: edit`, the Claude SDK runs Bash commands inside a macOS Seatbelt sandbox. This can cause `~/.gradle` writes and JVM-based build tools to fail with `Operation not permitted`. To run Bash commands outside the sandbox while keeping file-edit permissions controlled, use:

```yaml
provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
```

File-edit permissions continue to be governed by `permission_mode`.

<a id="pi-resource-loading"></a>

#### Pi resource loading (`extensions`, `no_*`)

Use `provider_options.pi` when a TAKT run should load Pi packages / extensions or restrict which Pi resource types are discovered:

```yaml
provider_options:
  pi:
    extensions:
      - npm:pi-fff
      # - git:https://github.com/example/pi-extension
      # - /absolute/path/to/local-extension
    no_extensions: true       # Disable discovery; still load the explicit extensions above
    no_skills: true           # Disable Pi Skill discovery
    no_prompt_templates: true # Disable Pi prompt-template discovery
    no_themes: true           # Disable Pi theme discovery
    no_context_files: true    # Disable Pi context-file discovery
```

- Explicitly list trusted npm packages, Git sources, or local paths in `extensions`. Unversioned npm sources reuse existing project and user installs in order, then resolve temporarily if neither works. Versioned npm and other sources are resolved temporarily.
- `no_extensions` stops automatic discovery but still loads sources listed in `extensions`. Other `no_*` settings stop discovery for their respective resources.
- To use extension tools in `readonly` or `edit`, explicitly name their source in `extensions`. With `allowedTools`, only listed tools can run; an empty list denies all tools. The same permissions apply when an extension replaces a builtin tool of the same name.
- In `full` mode without `allowedTools`, registered tools are available. If tool provenance cannot be verified, the Pi call stops.
- Pi permission modes restrict tool selection, not the OS sandbox. Explicit extensions run inside the TAKT process, so use trusted sources only. Extension URLs with embedded credentials are rejected.

These settings follow normal provider-option leaf priority, including `TAKT_PROVIDER_OPTIONS_PI_*`.

<a id="pi-system-prompt"></a>

#### Pi system prompt (`system_prompt_mode`)

`provider_options.pi.system_prompt_mode` controls how TAKT delivers its runtime prompt (persona, workflow context, and the step instruction) to the Pi SDK.

```yaml
provider_options:
  pi:
    system_prompt_mode: append  # default
```

- `append` (default): TAKT adds its runtime prompt after Pi's own system prompt. Pi keeps its built-in instructions, including documentation pointers, tool guidance, and the skill catalog
- `replace`: TAKT replaces Pi's built-in system prompt with its runtime prompt. Use this to keep the previous behavior or to control the Pi system prompt yourself

Choose `append` to keep Pi's built-in instructions, or `replace` to use only TAKT's instructions.

<a id="workflow-categories"></a>

## Workflow categories

Organize workflows into categories for better UI presentation in the `takt` workflow selection prompt.

In a category file, put category names under top-level `workflow_categories`. List workflow names, such as `default`, under each category's `workflows`. Use `show_others_category` and `others_category_name` to adjust the uncategorized group.

### Configuration

Categories can be configured in:
- `builtins/{lang}/workflow-categories.yaml` — default builtin categories (bundled with TAKT)
- `~/.takt/preferences/workflow-categories.yaml` — user overlay file, or a custom path set with `workflow_categories_file` in `~/.takt/config.yaml`

Write categories in a separate file. If needed, set its path with `workflow_categories_file` in `~/.takt/config.yaml`:

```yaml
# ~/.takt/preferences/workflow-categories.yaml (or the file set by workflow_categories_file)
workflow_categories:
  Development:
    workflows:
      - default: "Standard coding workflow"   # name: description adds it to the selection label
      - simple
    Backend:
      workflows: [dual-cqrs]
    Frontend:
      workflows: [dual]
  Research:
    workflows: [research, magi]

show_others_category: true         # Show uncategorized workflows (default: true)
others_category_name: "Other Workflows"  # Name for uncategorized category
```

### Category features

- **Nested categories** — Add categories under another category name.
- **Workflow descriptions** — Write `- name: description` under `workflows:` to show a description in the selection screen. Use the same description if a workflow appears in several categories.
- **Others category** — collects workflows not listed under any category (disable with `show_others_category: false`)
- **Builtin workflow filtering** — turn off all builtins with `enable_builtin_workflows: false`, or specific names with `disabled_builtins: [name1, name2]`

### Resetting Categories

Reset workflow categories to builtin defaults:

```bash
takt reset categories
```

## Pipeline Templates

Pipeline mode (`--pipeline`) supports customizable templates for branch names, commit messages, and PR bodies.

### Configuration

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

### Template Variables

| Variable | Available In | Description |
|----------|-------------|-------------|
| `{title}` | Commit message | Issue title |
| `{issue}` | Commit message, PR body | Issue number |
| `{issue_body}` | PR body | Issue body |
| `{report}` | PR body | Workflow execution report |

### Pipeline CLI Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode |
| `--auto-pr` | Create PR after execution |
| `--draft` | Create the auto-created PR as a draft (requires `--auto-pr` or `auto_pr` config) |
| `--skip-git` | Skip branch creation, commit, and push (workflow-only) |
| `--repo <owner/repo>` | Repository for PR creation |
| `--auto-strategy <strategy>` | Override auto routing strategy (`cost` \| `balanced` \| `performance`) |
| `-q, --quiet` | Minimal output mode (suppress AI output) |

## Debugging

### Debug Logging

Enable debug logging by setting `logging.debug: true` in `~/.takt/config.yaml` (the `logging` key is global-only):

```yaml
logging:
  debug: true
```

General debug logs are process-scoped and written to `.takt/runs/debug-{timestamp}/logs/debug-{timestamp}.log` in NDJSON format. Prompt/response logs are workflow-run-scoped and written to `.takt/runs/<run>/logs/<sessionId>-prompts.jsonl`.

### Detailed Console Output

Enable detailed console output by setting `logging.level: debug`:

```yaml
# ~/.takt/config.yaml
logging:
  level: debug
```

This also enables the internal verbose console mode used by the CLI. `logging.level: debug` alone additionally enables both the process-scoped general debug log and workflow-run-scoped prompt/response logs described above without setting `logging.debug` separately. Any of `logging.debug: true`, `logging.trace: true`, or `logging.level: debug` enables them.

## Companion provider targets

To use Companions, configure a provider in `runtime.yaml`. Assign a fixed profile to each name under `provider.targets.companions`; unassigned companions use `provider.defaults`. Companion targets cannot use a pool or ladder. If you still use legacy `config.yaml` provider settings, migrate them to runtime configuration.

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

Companion reviewers, moderators, and selectors run in `readonly` permission mode even if their profile sets another mode.

| Provider | Implementer tool events |
|---|---:|
| `claude-sdk` / `claude` | Live |
| `codex` | Live |
| `claude-headless` | Live |
| `claude-terminal` | Replayed after the turn |
| `mock` | Scenario-dependent |
| `opencode` | Live |
| `pi` | Live |
| `cursor`, `copilot`, `kiro` | Unavailable |

When live tool events are unavailable, completion review and turn-boundary finding delivery still run.

## Managed SDK installation and updates

Claude SDK, Codex, OpenCode, Pi and DeepSeek Harness SDKs are separate from the normal TAKT installation. Each TAKT release ships pinned manifests and locks. Installation uses `npm ci --omit=dev --ignore-scripts` in the managed directory and requires npm and registry access.

```sh
takt install claude-sdk
takt install codex
takt install opencode
takt install pi
takt install deepseek-harness
takt update           # Update installed providers with version drift only
takt update codex     # Update the selected provider only
```

Interactive entry points confirm required installations and approximate disk space before execution. Declining a missing SDK prevents execution; conversations display install advice and return to input. Declining an update uses an intact older SDK with a warning, and failures include update advice. Running workflows never prompt, install or update. Install required providers explicitly before CI, pipeline and watcher execution.

Approximate sizes are 250 MB for Claude SDK, 340 MB for Codex, 60 MB for OpenCode, 52 MB for Pi and 510 MB for DeepSeek Harness (measured on macOS arm64). Sizes vary by OS and architecture. Claude and Codex include managed CLI binaries. Explicit `TAKT_CLAUDE_CLI_PATH` and `TAKT_CODEX_CLI_PATH` overrides remain supported; same-name commands on PATH are not reused automatically. Install the external OpenCode CLI separately. Use `takt install <provider> --force` to reinstall. Failed updates preserve the previous intact generation.

## Merge selection

GitLab supports MR details, CI status acquisition, and bulk selection. When Caccia is enabled, its effect in `takt merge` and `from_pr` tasks returns `skipped` with `github_unavailable` and continues to CI on the returned head. Merged results pipelines are matched through the merge commit's second parent and the source head. Missing pipelines and pipelines for an older head do not pass CI. Selecting a merge method or constraining the head is still unsupported: `merge_pr` fails when either is supplied. Completing the CI wait does not imply a successful merge.

The default `merge.workflow` is `merge-review-fix-simple`. It gathers context, runs one read-only reviewer with dynamic facets, then adjudicates findings and handles fixes and verification in separate steps before the shared push, CI, CHANGES_REQUESTED, and merge flow. Set `merge.workflow: merge-review-fix` to use parallel review. A CLI `--workflow` overrides this setting.

Bulk `takt merge` runs use `merge.concurrency: 2` by default. Set it to a positive safe integer to change the number of concurrent PR workflows. The `--concurrency` CLI option overrides this setting. Root `concurrency` continues to control `takt run` and `takt watch`. An explicit PR number runs only that PR.

For a bulk `takt merge` run, TAKT collects all open PR numbers in creation order before reading each PR's details and applying `merge.where`, `include_draft`, and `include_forks`. A PR closed before its details are read is skipped. If the number listing fails, no PR workflow starts. An explicit PR number ignores selection conditions and still runs the fork threat check.
