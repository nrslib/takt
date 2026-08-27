# Configuration

[English](./configuration.md) | [日本語](./configuration.ja.md) | [简体中文](./configuration.zh-CN.md)

This document is a reference for all TAKT configuration options. For a quick start, see the main [README](../README.md).
For phase-level usage events and analysis, see the [Observability Guide](./observability.md).

## Global Configuration

Configure TAKT defaults in `~/.takt/config.yaml`. This file is created automatically on first run. All fields are optional.

TAKT compares existing global and project configuration directories by their real paths, and directories that do not yet exist by their normalized absolute logical paths. If the global configuration directory and the current project's `.takt/` match after this resolution, TAKT exits with an error before initializing either directory. If you run from your home directory or the paths collide through a symbolic link, set `TAKT_CONFIG_DIR` to a directory different from the project's `.takt/` and run TAKT again. `--help` and `--version` are exempt from this check.

```yaml
# ~/.takt/config.yaml
language: en                  # UI language: 'en' or 'ja'
logging:
  level: info                 # Log level: debug, info, warn, error
provider: claude              # Default provider: claude, claude-sdk, claude-terminal, codex, opencode, deepseek-harness, cursor, copilot, kiro, pi, or mock
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
concurrency: 1                # Parallel task count for takt run (1-10, default: 1 = sequential)
task_poll_interval_ms: 500    # Polling interval for new tasks during takt run (100-5000, default: 500)
interactive_preview_steps: 3  # Step previews in interactive mode (0-10, default: 3)
auto_requeue_max_attempts: 0  # Auto-requeue failed workflow tasks during takt run (non-negative integer, default: 0 = disabled)
ignore_exceed: false          # Applies to takt run and takt watch like --ignore-exceed (default: false)
assistant:
  formal_spec: 'y/N'          # Alloy/Quint mode: true, false, Y/n, or y/N (default: y/N)
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
#   claude:
#     default_permission_mode: edit

# API Key configuration (optional)
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY. DeepSeek Harness uses the official DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL environment variables (not YAML API-key fields).
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
#     provider: claude
#     model: opus
#   selector:              # optional selector override for dynamic parallel, dynamic_facets, and companion pools
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` is optional. Provider/model precedence is explicit CLI or environment override, project selector, global selector, project top-level, then global top-level. A model is accepted only when its candidate belongs to the resolved provider. Only selector entries contribute `provider_options`, merged by option leaf from global then project; top-level, persona, and pool sub-step options are not inherited by the selector. An empty selector entry or an empty `provider_options` entry is rejected during configuration loading. Dynamic parallel and `dynamic_facets` selectors use the provider-neutral fresh-session transport and pass the fixed read-only tool allowlist `Read`, `Glob`, `Grep` together with `permission_mode: readonly`. Companion selectors do not receive a fixed `allowedTools` list, so `allowed_tools` from the selector profile may be used. The tool allowlist is effective only for providers that honor it. Selector settings remain unused and do not affect workflows without dynamic parallel, dynamic facets, or an enabled companion pool.

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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | Default concrete AI provider (`claude` = headless CLI mode, `claude-sdk` = SDK/API mode, `claude-terminal` = experimental interactive terminal mode, `pi` = Pi SDK mode, `deepseek-harness` = official DeepSeek Harness Python SDK) |
| `model` | string | - | Default model name (passed to provider as-is) |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | Branch name generation strategy |
| `prevent_sleep` | boolean | `false` | Prevent macOS idle sleep (caffeinate) |
| `notification_sound` | boolean | `true` | Enable notification sounds |
| `notification_sound_events` | object | - | Per-event notification sound toggles |
| `concurrency` | number (1-10) | `1` | Parallel task count for `takt run` |
| `task_poll_interval_ms` | number (100-5000) | `500` | Polling interval for new tasks |
| `interactive_preview_steps` | number (0-10) | `3` | Step previews in interactive mode |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` | `"y/N"` | Adds Alloy/Quint guidance that expresses requirements in both notations. Duplication across notations is not avoided; a notation is omitted only when the task genuinely cannot be expressed in it. `true` and `false` are used without prompting. On a TTY, `"Y/n"` and `"y/N"` ask once per conversation session with Yes or No as the default; without a TTY, the default answer is used without consuming standard input. An explicit project value overrides the global value. Gherkin guidance applies only to development and implementation tasks. |
| `auto_requeue_max_attempts` | non-negative integer | `0` | Maximum automatic requeue attempts for failed workflow tasks during `takt run`; `0` disables automatic requeue |
| `ignore_exceed` | boolean | `false` | Configures iteration-limit bypass for `takt run` and `takt watch`; a CLI `--ignore-exceed` flag takes precedence when specified |
| `sync_project_local_takt_on_retry` | boolean | `true` | Sync the root project-local `.takt` into the worktree before retry / re-execution; set `false` to keep the worktree copy |
| `worktree_dir` | string | - | Directory for shared clones (defaults to `../{clone-name}`) |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
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

## Project Configuration

Configure project-specific settings in `.takt/config.yaml`. This file is created when you first use TAKT in a project directory.

```yaml
# .takt/config.yaml
provider: claude              # Override provider for this project
model: sonnet                 # Override model for this project
auto_pr: true                 # Auto-create PR after worktree execution
concurrency: 2                # Parallel task count for takt run in this project (1-10)
auto_requeue_max_attempts: 1  # Auto-requeue failed workflow tasks during takt run (non-negative integer)
ignore_exceed: false          # Applies to takt run and takt watch like --ignore-exceed
# base_branch: main           # Base branch for clone creation (overrides global, default: remote default branch)

# Project-specific assistant settings
# assistant:
#   formal_spec: 'Y/n'         # Override global Alloy/Quint mode; prompts on TTY with Yes as default
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
#     # python_path and cordis are trusted-global/env-only; project config
#     # uses the default python3 and cannot select a Cordis executable config.
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

# Provider-specific permission profiles (project-level override)
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     step_permission_overrides:
#       ai_review: readonly

```

### Pi provider session boundary

The TAKT Pi provider uses an embedded, in-memory Pi SDK session for the current TAKT process. It does not write Pi session JSONL files, and it does not read or write the Pi CLI global `settings.json`. Consequently, Pi global settings such as the default model, thinking level, shell, and retry options are not automatically inherited by TAKT.

Set the model explicitly in TAKT configuration when it should be the default for Pi. A Pi model can include a `:<thinking-level>` suffix, for example:

```yaml
# ~/.takt/config.yaml or .takt/config.yaml
provider: pi
model: provider/model:high
```

You can also set the model and thinking level on a workflow step:

```yaml
steps:
  - name: implement
    provider: pi
    model: provider/model:high
```

The `provider` and `model` declarations select the provider, model, and thinking level for a TAKT run; they do not import Pi CLI settings. Pi authentication is handled separately through the Pi SDK credential store or provider-native environment variables. The boundary avoids unintended writes to global settings and keeps project-local configuration trustworthy and predictable.

`provider_options.pi` is a separate path for loading Pi resources such as `extensions` and `no_*` discovery controls. These options do not declare authentication, model, or thinking level. Bare explicit npm sources reuse an existing project-scope install, then an existing user-scope install, and fall back to temporary resolution only when neither candidate loads successfully; version-qualified npm sources and non-npm sources are always resolved temporarily. Explicit sources are not persisted to Pi settings; see [Pi resource loading](#pi-resource-loading) for the resource trust boundary.

### Provider inactivity deadline and OpenCode execution guards

Every provider uses `guards.call_timeout_ms` as its maximum period without an
observable provider event. Each stream/tool event, phase completion, and new
provider attempt resets the timer; cumulative execution time is not capped.
It applies to `codex`, `opencode`, `claude` (including `claude-sdk`),
`claude_terminal`, `cursor`, `copilot`, `kiro`, and `pi`. Values are integer
milliseconds from 60,000 through 86,400,000; the default is 3,600,000 ms
(60 minutes). The normal `provider_options` profile resolution path resolves
this value into the engine's parent-step deadline, and the same `AbortSignal`
is passed to every provider. `claude_terminal.timeout_ms` is retained for
compatibility and is used only when `guards.call_timeout_ms` is unset.

`provider_options.opencode.guards.profile` is `standard` by default. `minimal`
disables heuristic loop detection only; time, bounded-resource, integrity, and
strict correction guards remain mandatory. `model_profiles` selects a profile
from the resolved model string in insertion order, with `*` as the only
wildcard. Guard leaves merge independently across provider-option layers, while
each higher-priority `model_profiles` value replaces the complete lower-priority
map.

Each OpenCode call has a 3,600,000 ms (60 minute) provider-event inactivity
limit. A healthy call may run longer while events continue to arrive.
`event_limit` defaults to 500,000 and can be overridden by
`TAKT_OPENCODE_STREAM_EVENT_LIMIT`. `text_byte_limit` defaults to 1 MiB and
`reasoning_byte_limit` to 4 MiB.

The timeout observes provider events as delivered; TAKT does not synthesize
keepalives. OpenCode tracks the interval from a tool-start event through its
terminal event as in-flight and suspends the ordinary inactivity check during
that interval. To keep a missing terminal event or complete hang bounded, the
in-flight state becomes stale after six times `call_timeout_ms` and ends as
`PART_TIMEOUT`.

Invalid numeric limits are treated differently per input path. Values written
under `guards.*` (including those from `TAKT_PROVIDER_OPTIONS_*`) are declared
configuration, so a non-positive-integer value fails fast with an error. Values
from `TAKT_OPENCODE_*` are ad-hoc overrides for experiments and tests, so an
invalid value is ignored and the default applies.

The legacy `TAKT_OPENCODE_TOOL_ERROR_BUDGET`,
`TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE`,
`TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS`,
`TAKT_OPENCODE_TOOL_SUCCESS_REPEATS`, and
`TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS` variables no longer control a
guard. They are ignored with a one-time warning. Remove them and use the
`guards` profile and bounded limits above; exact terminal-tool repetition is now
a fixed consecutive-tuple guard rather than the removed cumulative detectors.

### Project Config Field Reference

Project config accepts most global keys and overrides their global values (e.g. `language`, `branch_name_strategy`, `minimal_output`, `task_poll_interval_ms`, `interactive_preview_steps`, `provider_routing`, `persona_providers`, `runtime`, `analytics`, `telemetry`, `rate_limit_fallback`, `workflow_overrides` — see the [Global Config Field Reference](#global-config-field-reference) for their meaning). The project schema is strict: global-only keys such as `logging`, `disabled_builtins`, `enable_builtin_workflows`, notification settings, API keys, and CLI paths are rejected in `.takt/config.yaml` and cause a config validation error at startup. The table below lists project-only keys and the most common overrides.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"deepseek-harness"` \| `"pi"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | Override concrete provider |
| `model` | string | - | Override model name (passed to provider as-is) |
| `submodules` | `"all"` \| string[] | - | Project-only. Submodules to initialize in shared clones: `"all"` or an explicit path list (wildcards not supported) |
| `with_submodules` | boolean | - | Project-only. Legacy boolean equivalent of `submodules: "all"`; prefer `submodules` |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `draft_pr` | boolean | `false` (from global) | Create the auto-created PR as a draft |
| `concurrency` | number (1-10) | `1` (from global) | Parallel task count for `takt run` |
| `auto_requeue_max_attempts` | non-negative integer | `0` (from global/default) | Maximum automatic requeue attempts for failed workflow tasks during `takt run`; `0` disables automatic requeue |
| `ignore_exceed` | boolean | `false` (from global/default) | Configures iteration-limit bypass for `takt run` and `takt watch`; a CLI `--ignore-exceed` flag takes precedence when specified |
| `base_branch` | string | - | Base branch for clone creation (overrides global, default: remote default branch) |
| `assistant.init_files` | string[] | - | Project-only interactive assistant initial context files. Paths must be relative to the project root; absolute paths, paths resolving outside the project root, and sensitive file patterns such as `.env*`, `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`, and `.git/**` are rejected. Missing paths, directories, and unreadable files fail with a clear error. At most 16 files are allowed; each file is limited to 256 KiB and the combined content is limited to 1 MiB. When unset or empty, TAKT does not auto-discover `CLAUDE.md`, `AGENT.md`, `AGENTS.md`, `TAKT.md`, or other files. This is separate from `takt_providers.assistant`, which only controls the assistant provider/model. |
| `assistant.formal_spec` | boolean \| `"Y/n"` \| `"y/N"` | `"y/N"` (from global/default) | Project override for Alloy/Quint guidance that expresses requirements in both notations. Duplication across notations is not avoided; a notation is omitted only when the task genuinely cannot be expressed in it. Project values take precedence over global values. Answers to `"Y/n"` or `"y/N"` prompts are session-local and are resolved again when a conversation is resumed; ACP and non-TTY execution never prompt and use the configured default answer. Gherkin guidance applies only to development and implementation tasks. The deprecated `assistant.gherkin` key produces a warning and is ignored without conversion, persistence, or file modification. |
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

Separately from config-key overrides, `TAKT_NOTIFY_WEBHOOK` sets a Slack Incoming Webhook URL. When it is set, TAKT posts a Slack notification on pipeline completion and when a `takt run` task batch finishes (run summary).

## API Key Configuration

TAKT supports Claude, Codex, OpenCode, Pi, the official DeepSeek Harness SDK, Cursor, Copilot, and Kiro providers. Claude/Codex/OpenCode use their SDK credentials, Pi uses the Pi SDK credential store or provider environment variables, DeepSeek Harness uses the official `DEEPSEEK_API_KEY` environment variable, Kiro uses an API key, Cursor can use either API key or existing `cursor-agent login` session, and Copilot uses a GitHub token.

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

# For the official DeepSeek Harness SDK (Python 3.10+ runtime)
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
| DeepSeek Harness | `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`) | - |
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |
| Kiro CLI | `TAKT_KIRO_API_KEY` (`KIRO_API_KEY` fallback) | `kiro_api_key` |

### Security

- If you write API keys in `config.yaml`, be careful not to commit this file to Git.
- Consider using environment variables instead.
- Add `~/.takt/config.yaml` to your global `.gitignore` if needed.
- Cursor provider can run without API key when `cursor-agent login` is already configured.
- If you set credentials, installing the corresponding CLI tool (Claude Code, Codex, OpenCode, Pi) is not necessary. TAKT directly calls the respective API. DeepSeek Harness additionally requires Python 3.10+, matching `deepseek-harness-sdk`/`deepseek-harness-runtime-bin` packages, and Linux x64/arm64 or macOS arm64; Windows and macOS x64 are unsupported.
- The DeepSeek API key is passed only to the Python bridge environment, never to command arguments or workflow-generated config.
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

**Claude Code** supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). The `model` field is passed directly to the provider CLI. Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

**Codex** uses the model string as-is via the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

**OpenCode** requires a model in `provider/model` format (e.g., `opencode/big-pickle`). Omitting the model for the OpenCode provider will result in a configuration error.

**Pi** accepts `provider/model` references and bare model IDs that uniquely match a configured Pi model. A recognized `:<thinking-level>` suffix selects the Pi thinking level. If omitted, TAKT keeps the Pi session's current model.

**Cursor Agent** forwards `model` directly to `cursor-agent --model <model>`. If omitted, Cursor CLI default is used.

**GitHub Copilot CLI** forwards `model` directly to `copilot --model <model>`. If omitted, Copilot CLI default is used.

**Kiro CLI** forwards `model` directly to `kiro-cli chat --model <model>`. If omitted, Kiro CLI default is used.

### Example

```yaml
# ~/.takt/config.yaml
provider: claude
model: opus     # Default model for all steps (unless overridden)
```

Workflow `promotion` entries only advance the target ladder selected in
`runtime.yaml`; they cannot contain provider, model, provider-options, or
condition fields. `capabilities` remains the workflow-level way to request
tool, network, sandbox, or skill abilities without choosing the runtime.

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
```

The `companion` policy must specify at least one of `enabled` or `review_mode`.
A mode-only policy such as `companion: { review_mode: live }` is accepted and
resolves to `enabled: false`; an empty `companion: {}` policy is rejected.

When both global and project policies are specified, their values are combined
with logical AND; a project value of `true` cannot re-enable a globally disabled
companion. An omitted policy is neutral during layer merging, and Companion
remains disabled when neither layer specifies one.

`companion.review_mode` defaults to `completion`. The project value overrides the
global value, and a project omission inherits the global value. `completion`
reviews the cumulative diff after a successful implementer response; `live`
preserves quiet, forced, and commit-triggered reviews during the response. Only
`completion` and `live` are accepted, and invalid values fail while loading
`runtime.yaml`. The mode is validated even when `companion.enabled` is `false`,
but no Companion provider is resolved or executed in that case.

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

When enabled, every successful, failed, or interrupted source run starts the
builtin `loop-analysis` workflow asynchronously. The source run does not wait
for analysis, and an analysis startup or execution failure does not change the
source result. Analysis runs do not schedule another analysis run.
Runs terminalized through manual force-fail are also scheduled immediately after
their terminal artifacts are committed. Each source run creates at most one
analysis job.

If the process receives an OS-level forced termination (`SIGKILL`) after the
terminal artifacts are committed but before the analysis job is persisted, that
process cannot start the analysis itself. The dispatch claim is intentionally
at-most-once, so force-failing the run from the task list is not an automatic
recovery guarantee for a claim that was persisted immediately before the
process was killed.

The analyzer reads the source run's available JSONL logs, trace, monitor data,
reports, saved workflow definition, and the facets referenced by each step. It
expresses invariants shared by multiple steps as workflow-wide rules and
step-specific problems as changes to the responsible facet. The reviewer can
request explicit reanalysis up to two times when a proposal is unsupported,
over-specialized, or targets the wrong workflow behavior. Reanalysis classifies
each finding as addressed or unable to be addressed with evidence, withdraws
the affected proposal in the latter case, and returns it to the reviewer. The
final report is always written to the analysis run's `reports/loop-analysis.md`.

Before sanitization and publication, the worker also saves the complete report under
the global config directory (`TAKT_CONFIG_DIR` when set), at
`loop-analysis/<source-run-slug>-<hash>/loop-analysis.md`. Here `<hash>` is the first
8 hexadecimal characters of the SHA-256 hash of the source run directory path. It writes a private `source.json`
beside it with version 1, `sourceRunDirectory`, `projectCwd`, optional `branch`,
`analysisReportPath`, `archivedAt` (an ISO timestamp), and, only after a successful
PR comment, `pullRequest.number` and `pullRequest.url`. This archive is saved for
both output modes and is overwritten when the same source run directory is analyzed
again. The analysis report and, when present, the PR comment end with one
`source run: <source-run-slug>` line; the line contains only the slug.
After the archive is written, the worker sanitizes the analysis run's report
and overwrites it with the publication-safe content. The archive therefore
retains the complete report while the file and PR comment share the sanitized
content.

With `output: pr-comment`, the same persisted report content is also posted when
the source run has auto-PR enabled and its branch already has a pull request. If
no pull request exists, no comment is posted; the analysis report and private archive are retained. Provider, model, and
provider options are not valid inside `loop_analysis`; configure the analysis
steps through normal runtime provider targets. When both runtime files define
`loop_analysis`, the project section replaces the global section as a unit.

Before publication, TAKT removes recognized secrets, credentials, tokens,
personally identifiable data, absolute local paths, and runner-identifying
metadata. If redaction changes the report, the sanitized content replaces the
persisted report so the file and pull-request comment remain identical.

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

### Directory-specific assignments

`provider.assignments` defines named provider configuration sets that can be selected for a
project directory. Each entry must contain `defaults` or `targets`; an empty assignment is not
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

`provider.profiles` holds named provider/model/options definitions. A profile's flat `options` bag applies to that profile's provider (for example `reasoning_effort` maps to the Codex `reasoning_effort` option). Optional `capabilities` names one provider-options preset or a list of presets applied in order. Presets resolve project → global → builtin, like workflow capabilities, and inline `options` override preset values. Optional `permission_mode` selects the provider's exact permission mode. Profiles may reuse another profile with an explicit `extends`; there is no field-level merge between same-name profiles across the global and project files — the project definition replaces the whole profile.

TAKT-owned structured agents always start a fresh session. Providers with native structured output receive the schema directly; other providers receive a JSON schema instruction, and TAKT parses and validates the returned object. TAKT does not add internal-agent-specific permission, tool, network, sandbox, skill, MCP, or bypass policy. Assign a profile with `capabilities`, `permission_mode`, or both when a role needs restrictions. If both are omitted, normal provider configuration is used unchanged.

`provider.defaults` is required in every active provider section and must choose exactly one of a fixed `profile` or an ordered `ladder`. It cannot specify `pool`. Entries under `provider.targets.personas`, `provider.targets.tags`, and `provider.targets.steps` choose exactly one of a fixed `profile`, an ordered `ladder`, or an auto-routing `pool`; `pool` is valid only on these explicit workflow targets. `internal_agents` entries may use a fixed `profile` or an ordered `ladder`, but cannot use `pool`. `companions` entries must use a fixed `profile` and cannot use `pool` or `ladder`. Steps are named `<leaf-workflow-name>/<step-name>`; control nodes that do not run an agent (such as `workflow_call`) are not resolution targets.

When `provider.auto_routing` is present, only targets that explicitly name a `pool` are auto-routed. Targets without an explicit pool, non-workflow operations such as AI task-slug generation, and other auxiliary processing use `provider.defaults`; there is no implicit default pool. `fallback_profile` belongs to the explicitly selected pool and is not used as a non-workflow default.

### Resolution priority

A workflow agent's provider is resolved by this ladder, later entries overriding earlier ones:

```text
defaults
  < personas
  < tags
  < steps
```

The internal `selector`, `assistant`, `loop-judge`, and `review-completion-judge` agents resolve through a separate ladder. `selector` chooses dynamic work, `assistant` backs interactive sessions, `loop-judge` evaluates loop monitors, and `review-completion-judge` decides whether an opted-in reviewer needs another pass. Every seat is optional; an unassigned seat uses the ordinary default resolution.

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

The `mcp` section in `runtime.yaml` owns MCP server definitions and their assignment to agents. It is a top-level sibling of `provider` (order.md:36) and may be active alone (without a `provider` section), so MCP servers are injected while provider/model resolution stays on the legacy `config.yaml` path.

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
| `mcp.targets.internal_agents` | `{ selector: { exclude? } }` | Exclusions applied to both internal agents (`selector` and `assistant`). Only `selector.exclude` is accepted. |

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
| `claude` / `claude-sdk` / `claude-terminal` | `stdio`, `sse`, `http` |
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
| `readonly` | Read-only access, no file modifications | `default` | `read-only` | `read-only` | `read`, `grep`, `find`, `ls` | Cordis configuration | default flags (no `--force`) | no permission flags | `--trust-tools=read,grep` |
| `edit` | Allow file edits with confirmation | `acceptEdits` | `workspace-write` | `workspace-write` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` | Cordis configuration | default flags (no `--force`) | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | Bypass all permission checks | `bypassPermissions` | `danger-full-access` | `danger-full-access` | all registered Pi tools | Cordis configuration | `--force` | `--yolo` | `--trust-all-tools` |

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
  claude:
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

Provider and model are resolved independently at each layer. A provider-only override does not displace a higher-priority model override.

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

In legacy mode, the concrete top-level `provider` and `model` are the defaults.
Each `auto_routing.candidates` entry carries its own `provider` and `model`.
Candidate selection applies only to workflow step execution; internal operations
without workflow-step context, such as AI task-slug generation and sync conflict
resolution, use the concrete top-level defaults. The legacy
`auto_routing.router` and candidates are never implicit defaults.

Assistant conversations (interactive planning, instruct on existing tasks, and retry dialogue) do not go through auto routing. They resolve `takt_providers.assistant`, then fall back to the top-level provider/model when the assistant setting is unset; the assistant setting is not a default for other internal operations. CLI `--provider` / `--model` overrides apply to interactive planning only, while instruct and retry do not accept those overrides. Without a resolvable assistant or top-level provider, assistant startup fails with `Provider is not configured.`

In runtime mode, `provider.defaults` selects a profile or ladder for the runtime
default. Auto routing applies only when a persona, tag, or step target explicitly
selects a pool. Pool candidates reference `provider.profiles`; they do not carry
direct provider/model fields. Auto-routing hard rules are evaluated in `tags`,
`steps`, `personas` order when selecting a pool. Separately, the final provider
target override precedence is `defaults < personas < tags < steps`. Otherwise
`pool_rules` selects a candidate pool and the router estimates only the required
tier; TAKT deterministically selects the candidate.

Candidate `routing_tier` is limited to `high`, `medium`, or `low`. Runtime
profiles carry provider/model/options, so candidates reference profiles rather
than repeating those fields. CLI can override the strategy with
`--auto-strategy cost|balanced|performance`; the override is propagated until
execution reaches a runtime auto-routing target.

Routing decisions are local-only telemetry and are not recorded by default. When `telemetry.routing_decisions` is enabled (`takt telemetry enable` or `routing_decisions: true`), TAKT writes them as NDJSON under the project `.takt/events/` directory. TAKT does not upload routing decisions. Use `takt telemetry status`, `takt telemetry enable`, and `takt telemetry disable` to inspect or change only this local recording setting.

Provider options are resolved from runtime profiles, capability presets, and
the retained config/env override paths. Workflow YAML cannot define inline
provider options, so there is no step or workflow option layer to outrank
runtime settings. Preview, doctor, validation, summary, and report use the
same runtime resolution contract as execution.

`provider_options` priority is resolved per leaf. For most leaves, an env- or CLI-resolved config leaf overrides all other sources. `base_url` is the exception: step and workflow routing configuration stays above TAKT env overrides so a workflow can explicitly route only selected providers through a proxy. For `base_url`, the order is step `provider_options` > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > deprecated `persona_providers` > `workflow_config.provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml` > TAKT env override. Preview, doctor, validation, summary, report, and other auxiliary entry points use the same `base_url` priority order as workflow execution. For other leaves, after env/CLI config overrides, the same step-to-global order applies.

For safety, workflow YAML and project `.takt/config.yaml` may only set `base_url` to loopback hosts such as `127.0.0.1`, `127.x.x.x`, `localhost`, `*.localhost`, or `::1`. Put non-loopback provider base URLs in global config or `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` / `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL` / `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL`, where the setting is user-controlled.

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

Provider option leaves can also be overridden from env. For OpenCode model variants, use `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` to set `provider_options.opencode.variant`. For provider base URLs, use `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` or `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787`; these populate the config layer and do not override step or workflow routing `base_url` leaves. For DeepSeek Harness, use `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_BASE_URL=http://127.0.0.1:8787/v1` for a user-controlled endpoint. The official SDK reads `DEEPSEEK_API_KEY` and optional `DEEPSEEK_BASE_URL`; TAKT passes those values only to the private Python bridge. For Codex permission control, use `TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL=takt` or `TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL=codex`. For Codex Skill inheritance, use `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_REPO=true` or `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_USER=true`. For Claude Skill inheritance, use `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED=true`. For Claude terminal, use `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`, or `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500`. For Kiro custom agents, use `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` to set `provider_options.kiro.agent`. For Pi resource loading, use `TAKT_PROVIDER_OPTIONS_PI_EXTENSIONS='["npm:pi-fff"]'`, `TAKT_PROVIDER_OPTIONS_PI_NO_EXTENSIONS=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_SKILLS=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_PROMPT_TEMPLATES=true`, `TAKT_PROVIDER_OPTIONS_PI_NO_THEMES=true`, or `TAKT_PROVIDER_OPTIONS_PI_NO_CONTEXT_FILES=true`.

This allows runtime targets to mix providers and models within a single workflow while keeping display names independent from provider selection.

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

TAKT passes `provider_options.claude.base_url` to `claude` and `claude-sdk` as `ANTHROPIC_BASE_URL`. TAKT passes `provider_options.codex.base_url` to the Codex SDK constructor as `baseUrl`. For `deepseek-harness`, `provider_options.deepseek_harness.base_url` is passed to the official Python SDK through `DEEPSEEK_BASE_URL`. `claude-terminal`, `opencode`, `cursor`, `copilot`, `kiro`, and `pi` are not included in this base URL support unless documented separately.

Provider-native environment variables such as `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` are provider fallback settings. A TAKT `provider_options.*.base_url` value is explicit TAKT configuration and takes priority over those provider-native settings for the providers above.

This also works for routing through an external proxy or gateway service — any endpoint that speaks the OpenAI- or Anthropic-compatible API — as long as the URL is set at a layer allowed to use non-loopback hosts (global config or the `TAKT_PROVIDER_OPTIONS_*_BASE_URL` environment variables). The workflow and project layers accept loopback addresses only.

Workflow and project config can use `base_url` for local proxies only. Non-loopback proxy endpoints must be configured from global config or TAKT env so untrusted workflow files cannot redirect API keys and prompts to an arbitrary host.

#### DeepSeek Harness (`deepseek-harness`)

`deepseek-harness` starts the official `deepseek-harness-sdk` in a Python 3.10+ child process and communicates with it over a line-oriented JSON-RPC bridge. Install the SDK and its matching `deepseek-harness-runtime-bin` wheel separately:

```bash
python3 -m pip install deepseek-harness-sdk deepseek-harness-runtime-bin
```

The verified official runtime wheels support Linux x64/arm64 and macOS arm64. Windows and macOS x64 are unsupported and fail fast; TAKT never falls back to another provider. Authentication is intentionally environment-based: set `DEEPSEEK_API_KEY`, and optionally `DEEPSEEK_BASE_URL`. The API key is not written to workflow/config files or command arguments.

This provider is a developer-preview compatibility surface: the SDK and runtime wheel must be matching releases, and the upstream event/API vocabulary can change between releases. Run the live smoke only when you intentionally want to spend DeepSeek API quota; normal unit, integration, and mock E2E suites never call DeepSeek.

Opt-in live smoke (supported Linux/macOS only):

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
    base_url: http://127.0.0.1:8787/v1  # optional; loopback in project/workflow config
    session_root: .takt/deepseek-sessions
    max_tokens: 4096
    request_timeout_ms: 3600000
    shutdown_timeout_ms: 1000
    runtime_mode: exe                  # exe or node; node is for explicit SDK development mode
```

For credential safety, `python_path` is accepted only from trusted global configuration or `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PYTHON_PATH`; workflow and project-local provider options must use the default `python3` executable. `cordis` is also accepted only from trusted global configuration or `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_CORDIS`, because it selects executable tool composition. The example above intentionally omits both fields. The same restrictions apply to project `runtime.yaml` profiles; global runtime profiles may select trusted values. Project runtime profiles may use only loopback `base_url` values.

`session_root` and `cordis` are resolved relative to the configured working directory. Sessions are reused when a workflow supplies `session_key`; one-shot calls close the bridge immediately. `request_timeout_ms` terminates the complete Python bridge request, and aborting a TAKT call terminates the bridge process tree. Stream events are converted from official `session.event` notifications into TAKT text, thinking, tool-use, tool-result, error, and result events. System prompts, TAKT `allowed_tools`, MCP server maps, image attachments, structured output, permission modes, and `maxTurns` are not part of the official SDK call and are ignored with a warning; configure system/tool composition through Cordis instead.

The corresponding environment overrides are `TAKT_PROVIDER_OPTIONS_DEEPSEEK_HARNESS_PYTHON_PATH`, `_BASE_URL`, `_SESSION_ROOT`, `_CORDIS`, `_MAX_TOKENS`, `_REQUEST_TIMEOUT_MS`, `_SHUTDOWN_TIMEOUT_MS`, and `_RUNTIME_MODE`. The `base_url` environment override is user-controlled and may be non-loopback. `runtime_mode: node` requires the official SDK's development Node carrier and is never selected implicitly.

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

The setting follows the existing provider-option leaf resolution and source attribution. It can
come from a runtime profile, `provider_routing.personas`, `provider_routing.tags`,
`provider_routing.steps`, project or global `provider_options`, or the environment override.
`takt exec` uses the resolved runtime default provider options for its assistant session as well.

#### Codex permission control (`permission_control`)

Codex uses TAKT's permission mode mapping by default. This is equivalent to `permission_control: takt` and passes the resolved TAKT `permission_mode` to the Codex SDK as `sandboxMode`. `network_access`, when set, is also passed as `networkAccessEnabled`; when omitted, Codex keeps its default (`false`).

To delegate permission control to Codex, explicitly opt in:

```yaml
provider_options:
  codex:
    permission_control: codex
```

With `permission_control: codex`, TAKT omits both `sandboxMode` and `networkAccessEnabled` from every Codex call, including strict isolated structured calls. Codex's `config.toml`, `default_permissions`, and permission profile determine the effective permissions. TAKT still sets `approvalPolicy: never` for non-interactive execution. `permission_control: codex` cannot be combined with `network_access`; the resolved configuration fails fast when both remain set. This is an explicit opt-in and its permission behavior is the user's responsibility.

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

TAKT disables filesystem Skill discovery for `claude-sdk`, `claude`, and `claude-terminal` by default. Enable it only when a workflow intentionally depends on repository or user Skills:

```yaml
provider_options:
  claude:
    skills:
      enabled: true
```

With `enabled: false`, `claude-sdk` receives `skills: []`; `claude` and `claude-terminal` receive `--disable-slash-commands`. This also disables custom Claude slash commands for those CLI sessions. With `enabled: true`, TAKT adds no Skill option or flag, preserving Claude's normal discovery. The setting follows normal provider-option leaf priority, including `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED`, and is retained for retries and resumed sessions.

This is a context filter, not a sandbox: a Skill file can still be reachable through Read or Bash. TAKT does not change `settingSources`, Claude settings, or user/repository Skill files. The bundled Agent SDK version is `0.3.206`. CLI sessions require a Claude Code version that supports `--disable-slash-commands`; TAKT verifies the flag before starting either a headless (`claude`) or terminal (`claude-terminal`) CLI session and reports an update error when unavailable. Claude Code `2.1.220` is the verified minimum.

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

- `extensions` accepts npm packages, Git sources, and local paths.
- Bare explicit npm sources reuse an existing project-scope install first, then an existing user-scope install; when neither can be resolved to enabled resources, TAKT falls back to temporary resolution without installing into either persistent scope. Version-qualified npm sources are always resolved temporarily.
- Explicit non-npm sources are resolved temporarily for the TAKT run.
- Explicit sources are not persisted into Pi settings.
- `no_extensions` disables extension discovery but still loads the sources listed in `extensions`.
- The other `no_*` options disable discovery of their respective resource types.
- Implicit project-local Pi resources are not trusted or loaded; only the absolute path discovered for an explicitly configured npm source can be reused from project package storage.
- Explicit extensions execute inside the TAKT process, so configure only trusted local paths and package sources.
- Extension URLs containing embedded credentials or secret-bearing query parameters are rejected.

These settings follow normal provider-option leaf priority, including `TAKT_PROVIDER_OPTIONS_PI_*`.

<a id="workflow-categories"></a>

## Workflow categories

Organize workflows into categories for better UI presentation in the `takt` workflow selection prompt.

**Canonical YAML keys** (recommended, matches bundled `builtins/{lang}/workflow-categories.yaml`): top-level **`workflow_categories`**, and under each category object the **`workflows`** array listing **workflow names** (the `name` field from each workflow YAML, e.g. builtin `default`), not file paths.

Category structure uses the canonical keys **`workflow_categories`** and **`workflows`**; the file also accepts the optional top-level settings `show_others_category` and `others_category_name` shown above. Removed legacy category keys are not accepted and cause a validation error.

### Configuration

Categories can be configured in:
- `builtins/{lang}/workflow-categories.yaml` — default builtin categories (bundled with TAKT)
- `~/.takt/preferences/workflow-categories.yaml` — user overlay file, or a custom path set with `workflow_categories_file` in `~/.takt/config.yaml`

`workflow_categories` cannot be written in `~/.takt/config.yaml` itself; the config schema is strict and rejects the key. Only the file path (`workflow_categories_file`) goes into `config.yaml` — the categories live in the dedicated overlay file:

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

- **Nested categories** — unlimited depth for hierarchical organization; under a category, every key other than `workflows` is treated as a child category name (there is no `children:` key)
- **Per-category workflow lists** — under each category, `workflows:` holds workflow names to show in that group
- **Workflow descriptions** — write a `workflows:` entry as `- name: description` to append a short description to its selection label (plain string entries still work). For a workflow listed in multiple categories, write the same description at each occurrence; conflicting descriptions for the same workflow in one file are rejected as a validation error. User overlay entries override builtin entries by workflow name and may add user-only names
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

Companions require an active `runtime.yaml` provider section. Assign each referenced companion through `provider.targets.companions`; an omitted name uses `provider.defaults`. Companion targets must name a fixed profile; pool and ladder assignments are rejected while parsing `runtime.yaml`. Legacy `config.yaml` provider settings are not a fallback and are rejected with migration guidance when a workflow uses `companion`.

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

Companion structured calls use the same provider-neutral fresh-session transport as other TAKT-owned structured agents. Native structured output is used where available; other providers use the validated JSON fallback. Companion reviewer, moderator, and selector calls always run in `readonly` permission mode; the permission mode configured on the resolved profile is not applied to these calls.

| Provider | Implementer tool events |
|---|---:|
| `claude-sdk` | Live |
| `codex` | Live |
| `claude` (headless) | Live |
| `claude-terminal` | Replayed after the turn |
| `mock` | Scenario-dependent |
| `opencode` | Live |
| `pi` | Live |
| `cursor`, `copilot`, `kiro` | Unavailable |

When live tool events are unavailable, completion review and turn-boundary finding delivery still run.
