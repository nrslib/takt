# Configuration

[日本語](./configuration.ja.md)

This document is a reference for all TAKT configuration options. For a quick start, see the main [README](../README.md).
For phase-level usage events and analysis, see the [Observability Guide](./observability.md).

## Global Configuration

Configure TAKT defaults in `~/.takt/config.yaml`. This file is created automatically on first run. All fields are optional.

```yaml
# ~/.takt/config.yaml
language: en                  # UI language: 'en' or 'ja'
logging:
  level: info                 # Log level: debug, info, warn, error
provider: claude              # Default provider: claude, claude-sdk, claude-terminal, codex, opencode, cursor, copilot, kiro, or mock
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
  gherkin: false              # Generate final task instructions as Markdown + focused Gherkin
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
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY / TAKT_CURSOR_API_KEY / TAKT_COPILOT_GITHUB_TOKEN / TAKT_KIRO_API_KEY
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
#   selector:              # optional dynamic-parallel selector override
#     provider: codex
#     model: gpt-5
#     provider_options:
#       codex:
#         reasoning_effort: medium
```

`takt_providers.selector` is optional. Provider/model precedence is explicit CLI or environment override, project selector, global selector, project top-level, then global top-level. A model is accepted only when its candidate belongs to the resolved provider. Only selector entries contribute `provider_options`, merged by option leaf from global then project; top-level, persona, and pool sub-step options are not inherited by the selector. An empty selector entry or an empty `provider_options` entry is rejected during configuration loading. Dynamic selectors require a provider that guarantees strict read-only internal-agent isolation; Claude, Codex, and Mock satisfy this contract, while OpenCode, Cursor, Copilot, and Kiro are rejected before selector or participant startup. Selector settings remain unused and do not affect workflows without dynamic parallel.

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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | Default concrete AI provider (`claude` = headless CLI mode, `claude-sdk` = SDK/API mode, `claude-terminal` = experimental interactive terminal mode) |
| `model` | string | - | Default model name (passed to provider as-is) |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | Branch name generation strategy |
| `prevent_sleep` | boolean | `false` | Prevent macOS idle sleep (caffeinate) |
| `notification_sound` | boolean | `true` | Enable notification sounds |
| `notification_sound_events` | object | - | Per-event notification sound toggles |
| `concurrency` | number (1-10) | `1` | Parallel task count for `takt run` |
| `task_poll_interval_ms` | number (100-5000) | `500` | Polling interval for new tasks |
| `interactive_preview_steps` | number (0-10) | `3` | Step previews in interactive mode |
| `assistant.gherkin` | boolean | `false` | Organize important observable behavior, state transitions, boundaries, failures, and invariants in a minimal number of Gherkin scenarios in final task instructions generated from assistant conversations. An explicit project value overrides the global value. |
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

# Explicit initial context files for interactive assistant mode only (project config only)
# assistant:
#   gherkin: true              # Generate final task instructions as Markdown + focused Gherkin
#   init_files:
#     - docs/assistant-context.md
#     - .takt/assistant-notes.md

# Provider-specific options (project defaults; env-resolved leaf overrides win, otherwise step > provider_routing > deprecated persona_providers > workflow > project > global)
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

### OpenCode execution guards

`provider_options.opencode.guards.profile` is `standard` by default. `minimal`
disables heuristic loop detection only; time, bounded-resource, integrity, and
strict correction guards remain mandatory. `model_profiles` selects a profile
from the resolved model string in insertion order, with `*` as the only
wildcard. Guard leaves merge independently across provider-option layers, while
each higher-priority `model_profiles` value replaces the complete lower-priority
map.

Each OpenCode call has a 3,600,000 ms (60 minute) wall-clock limit. A call that
may run longer than 60 minutes — a step that runs a full test suite, for
example — must explicitly set `call_timeout_ms` from 60,000 through 86,400,000.
`event_limit` defaults to 500,000 and can be overridden by
`TAKT_OPENCODE_STREAM_EVENT_LIMIT`. `text_byte_limit` defaults to 1 MiB and
`reasoning_byte_limit` to 4 MiB.

Stream silence counts as an idle timeout after 10 minutes
(`TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS` overrides it), but the clock is not
running while a tool call is in flight. OpenCode emits no events between
tool_use and tool_result, so treating a long-running tool — a test suite run,
for example — as inactivity would cut a healthy execution. A tool that never
returns is handled by the `call_timeout_ms` wall-clock limit. The operational
consequence: while a tool is in flight, a genuinely stuck run is detected after
`call_timeout_ms` (60 minutes by default, longer if you raise it) rather than
after 10 minutes. A dropped tool-result event does not disable detection either
— an in-flight call is discarded as stale once six times the idle timeout has
passed since it was registered. The converse also holds: if a single tool call
can stay silent for longer than six idle timeouts — for example when you raise
`call_timeout_ms` to allow long-running tools — raise
`TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS` as well. Staleness is measured against
the idle timeout, so raising only one of the two makes a healthy tool run count
as stale.

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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | Override concrete provider |
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
| `assistant.gherkin` | boolean | `false` | Project override for final task instructions generated from assistant conversations, including quiet mode. When enabled, TAKT keeps background, scope, implementation details, design intent, constraints, and verification in Markdown, and asks the summarizer to use a minimal number of Gherkin scenarios only for important observable behavior, state transitions, boundaries, failures, and invariants. When unset, TAKT uses the global value; when both are unset, it defaults to `false`. |
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

The Finding Contract intake normalizer has no `config.yaml` key. Every Finding
Contract reviewer writes an ordinary Markdown report; TAKT saves that report and
passes only it to a fresh tool-free structured session, once per reviewer per round.
That session's provider/model resolve in this order: the runtime.yaml
`provider.targets.internal_agents['intake-normalizer']` seat, then the reviewer's
`escalate` target when its profile declares one, then the ordinary default
resolution. The first candidate must support isolated structured execution; when it
does not, the run fails with that reason instead of silently continuing. When the
normalizer's output survives neither validation nor its single correction, TAKT
retries the normalization once on the next candidate of that same chain that
resolves to a different `(provider, model)` and can run isolated structured
execution; if that also fails, the run stops with each candidate's concrete reason.
The normalizer is a synthetic step and resolves like any other one, so an explicit
CLI or environment provider/model override applies to it too. That is deliberate —
an explicit override is the highest-priority layer everywhere in TAKT. The
consequence is that overriding a Finding Contract run onto a provider without
isolated structured execution stops the run with the normalizer's reason instead of
silently degrading. A rate-limit fallback registered for the
`finding_intake_normalizer` operation replaces the normalizer for that call only.

The removed `finding_contract.intake_normalize` key no longer exists: normalization
is built-in behavior now. A workflow that still declares it fails to load on the
strict schema's unknown-key rejection — delete the block.

Run metadata, session logs, traces, reports, and other run lifecycle artifacts
are files under `.takt/runs/<run>/`. Finding Contract state is separate: TAKT
lazily creates `.takt/runs/<run>/finding-contract.sqlite` only when a Finding
authority is first resolved. The database is an internal, run-scoped authority
for Finding Contract management, not the run record itself. Resume and requeue
may seed a target run from the source run's Finding database even though the
target is a different run. If the source has no Finding database, the target
starts with an empty ledger instead of rejecting the resume.

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

TAKT supports Claude, Codex, OpenCode, Cursor, Copilot, and Kiro providers. Claude/Codex/OpenCode/Kiro use API keys, Cursor can use either API key or existing `cursor-agent login` session, and Copilot uses a GitHub token.

### Environment Variables (Recommended)

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...

# For OpenCode
export TAKT_OPENCODE_API_KEY=...

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
| Cursor Agent | `TAKT_CURSOR_API_KEY` | `cursor_api_key` |
| GitHub Copilot CLI | `TAKT_COPILOT_GITHUB_TOKEN` | `copilot_github_token` |
| Kiro CLI | `TAKT_KIRO_API_KEY` (`KIRO_API_KEY` fallback) | `kiro_api_key` |

### Security

- If you write API keys in `config.yaml`, be careful not to commit this file to Git.
- Consider using environment variables instead.
- Add `~/.takt/config.yaml` to your global `.gitignore` if needed.
- Cursor provider can run without API key when `cursor-agent login` is already configured.
- If you set an API key, installing the corresponding CLI tool (Claude Code, Codex, OpenCode) is not necessary. TAKT directly calls the respective API.
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

Provider and model selection uses the single, field-by-field precedence contract documented under [Provider Routing](#provider-routing). Normal steps, parallel sub-steps, synthetic steps, and workflow calls follow that contract for the layers available to each kind. Parallel sub-steps do not support promotion.

Finding Contract workflows never name a provider or model. The synthetic roles are assigned in `runtime.yaml` through the optional `provider.targets.internal_agents` seats, and an assigned seat is treated as a step-level value for that role's synthetic step. The implementation's field-by-field order is explicit CLI/environment override → promotion matching the current execution (normal agent steps only) → step or parallel sub-step provider/model (including an assigned seat) → `workflow_call` override → `provider_routing` step/tag/persona → deprecated `persona_providers` → auto routing → workflow → project → global → provider default. An unassigned seat uses the normal workflow-step fallback chain. A seat that names only a provider stops lower-priority model fallback; providers that require an explicit model fail validation.

```yaml
# runtime.yaml
version: 1
provider:
  profiles:
    strong: { provider: codex, model: <strong-model> }
  targets:
    internal_agents:
      findings-manager:     { profile: strong }
      terminal-adjudicator: { profile: strong }
      loop-judge:           { profile: strong }
      escalation-reviewer:  { profile: strong }
      intake-normalizer:    { profile: strong }
```

In workflow YAML, `model: null` is an explicit model omission for a normal step, parallel sub-step, or `loop_monitors.judge`. It differs from leaving `model` unspecified: an unspecified model continues to applicable lower-priority sources such as routing, workflow, the triggering step for loop monitor judges, and input sources, while `model: null` stops model resolution at that entry and leaves the effective model undefined. Use it when the resolved provider should use its own CLI or provider default instead of inheriting another model source. Providers that require an explicit model still fail validation when no model is supplied.

### Provider-specific Model Notes

**Claude Code** supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). The `model` field is passed directly to the provider CLI. Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

**Codex** uses the model string as-is via the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

**OpenCode** requires a model in `provider/model` format (e.g., `opencode/big-pickle`). Omitting the model for the OpenCode provider will result in a configuration error.

**Cursor Agent** forwards `model` directly to `cursor-agent --model <model>`. If omitted, Cursor CLI default is used.

**GitHub Copilot CLI** forwards `model` directly to `copilot --model <model>`. If omitted, Copilot CLI default is used.

**Kiro CLI** forwards `model` directly to `kiro-cli chat --model <model>`. If omitted, Kiro CLI default is used.

### Example

```yaml
# ~/.takt/config.yaml
provider: claude
model: opus     # Default model for all steps (unless overridden)
```

```yaml
# workflow.yaml - step-level model selection
steps:
  - name: plan
    model: opus       # This step uses opus regardless of global config
    ...
  - name: implement
    # No model specified - falls back to global config (opus)
    ...
```

## Runtime Provider Configuration (runtime.yaml)

`runtime.yaml` keeps provider/model/options out of your workflows so the same workflow can run in different execution environments without edits. It is read from two fixed paths, with the project file taking priority over the global one:

1. `~/.takt/runtime.yaml`
2. `<project>/.takt/runtime.yaml`

Runtime mode is enabled by the presence of an active `provider` section, not by the file existing. A file that only contains `version: 1` is inactive and leaves the legacy `config.yaml` provider resolution in place.

### Configuration example

```yaml
version: 1

provider:
  defaults:
    pool: sol-pool

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
      escalate: sol-high
    router:
      provider: codex
      model: gpt-5.6-luna
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
    internal_agents:
      selector:
        profile: router
      intake-normalizer:
        profile: sol-high
      findings-manager:
        profile: sol-high
      terminal-adjudicator:
        profile: sol-high

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

`provider.profiles` holds named provider/model/options definitions. A profile's flat `options` bag applies to that profile's provider (for example `reasoning_effort` maps to the Codex `reasoning_effort` option). Profiles may reuse another profile with an explicit `extends`; there is no field-level merge between same-name profiles across the global and project files — the project definition replaces the whole profile.

`provider.defaults` and every `provider.targets` entry choose exactly one of a fixed `profile` or an auto-routing `pool`. Steps are named `<leaf-workflow-name>/<step-name>`; control nodes that do not run an agent (such as `workflow_call`) are not resolution targets.

### `escalate` — this profile's last move

A profile may name another profile with `escalate`. It declares "when work resolved to this profile runs out of room, hand it to that profile instead". One line on the weaker profile is the whole configuration; workflows never name a provider or a model.

```yaml
provider:
  profiles:
    reviewer-local:
      provider: opencode
      model: ollama-cloud/gemma4:31b
      escalate: strong
    strong:
      provider: opencode
      model: ollama-cloud/glm-5.2
```

- References are validated when the configuration is compiled, before any agent runs: an unknown target, a profile that escalates to itself, and a cyclic `escalate` chain are all load-time errors.
- `escalate` is inherited through `extends`, like `provider` / `model` / `options`.
- Only one hop is ever consumed. `escalate` is a worker's last move, not a ladder.
- A step whose provider comes from an explicit `--provider`, step YAML, or `workflow_call` override is no longer running on that profile, so it has no escalation target. Steps assigned through an auto-routing `pool` do not carry one either.
- Today the engine consumes `escalate` for Finding Contract escalated re-review; see [workflows.md](workflows.md).

### Resolution priority

A workflow agent's provider is resolved by this ladder, later entries overriding earlier ones:

```text
defaults
  < personas
  < tags
  < steps
```

The internal `selector`, `assistant`, `intake-normalizer`, `findings-manager`,
`terminal-adjudicator`, `loop-judge`, and `escalation-reviewer` agents resolve through a separate
ladder — `internal_agents` is not a generic override applied after step resolution:

```text
defaults
  < internal_agents.<agent>
```

`terminal-adjudicator` is the runtime name of the role whose persona facet is `supervisor`; the
two are deliberately different names for different things.

**Every seat is optional.** An unassigned seat changes nothing: the role keeps the resolution it
has always used. For the synthetic Finding Contract roles that means persona routing (the fixed
keys `findings-manager` / `supervisor` / `loop-judge`) and then the workflow → project → global →
provider-default chain. `intake-normalizer` continues past that into the reviewer profile's
`escalate` target before the ordinary default resolution (see [workflows.md](workflows.md)).

`escalation-reviewer` is the one seat that never changes *whether* a role runs. Escalated
re-review fires only for a reviewer whose resolved profile declares `escalate`; a reviewer without
that declaration keeps its own last presentation whether or not the seat is assigned. The seat only
replaces the destination of an escalation that the `escalate` declaration already enabled.

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
| `finding_contract.manager.provider` / `model` | `provider.targets.internal_agents.findings-manager` |
| `finding_contract.adjudicator.provider` / `model` | `provider.targets.internal_agents.terminal-adjudicator` |
| `auto_routing` | `provider.auto_routing` |
| auto routing candidates | pool candidates that reference `provider.profiles` |
| workflow-level provider settings | `provider.targets.steps` |

The last two rows are workflow YAML keys rather than `config.yaml` settings, and they are gone
rather than deprecated: the `finding_contract` schema is strict, so a leftover `provider` or
`model` under `manager` / `adjudicator` is rejected at load time as an unrecognized key, naming the
key and its path. Move the value to the matching `internal_agents` seat, or drop it and let the
role resolve through the layers below.

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

## Provider Profiles

Provider profiles allow you to set default permission modes and per-step permission overrides for each provider. This is useful when running different providers with different security postures.

### Permission Modes

TAKT uses three provider-independent permission modes:

| Mode | Description | Claude | Codex | OpenCode | Cursor Agent | Copilot | Kiro CLI |
|------|-------------|--------|-------|----------|--------------|---------|----------|
| `readonly` | Read-only access, no file modifications | `default` | `read-only` | `read-only` | default flags (no `--force`) | no permission flags | `--trust-tools=read,grep` |
| `edit` | Allow file edits with confirmation | `acceptEdits` | `workspace-write` | `workspace-write` | default flags (no `--force`) | `--allow-all-tools --no-ask-user` | `--trust-tools=read,grep,write,shell` |
| `full` | Bypass all permission checks | `bypassPermissions` | `danger-full-access` | `danger-full-access` | `--force` | `--yolo` | `--trust-all-tools` |

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

### Provider Routing

Use `provider_routing` to route workflow steps to different providers, models, and provider-specific options without duplicating workflows. You can define this in either `~/.takt/config.yaml` or `.takt/config.yaml`:

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

`provider_routing.personas` uses the raw `persona` key from the workflow step, so `persona_name` is display-only and does not affect routing. `provider_routing.tags` applies entries matching the step's `tags`; when multiple tags match, TAKT applies them in the order written on the step, and later tags override the same provider/model/provider_options leaf. For example, builtin final-gate steps put `final-gate` after `review`, so you can route ordinary reviewers to OpenCode while overriding only merge-readiness / supervisor to a high-reasoning Codex model. For finer routing, target `merge-readiness` and `supervise` separately. `provider_routing.steps` uses the workflow step `name`.

Each routing entry can include `provider`, `model`, and/or `provider_options`. Those fields are individually optional, but each entry must include at least one of them. Empty `provider_options` objects are rejected.

For `provider` / `model`, the complete workflow-step resolution priority is:

```text
explicit CLI / environment override
> active promotion (normal agent steps only; unsupported on parallel sub-steps)
> step or parallel sub-step YAML provider/model
> workflow_call override
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # deprecated legacy
> effective auto_routing (auto.rules / auto.dynamic / auto.fallback)
> workflow_config.provider/model
> project .takt/config.yaml
> global ~/.takt/config.yaml
> provider default
```

Provider and model are resolved independently at each layer. A provider-only override does not displace a higher-priority model override.

`active promotion` means a normal agent step `promotion` entry whose execution-count (`at: <N>`) or `ai()` condition matched for the current execution. Parallel sub-steps cannot specify promotion, so their YAML provider/model follows an explicit CLI/environment override directly; see [Step-level Provider Promotion](./workflows.md#step-level-provider-promotion).

An assigned `internal_agents` seat occupies the `step YAML provider/model` position for the role's synthetic step. Every seat is optional; an unassigned seat leaves the role on the layers below.

Without a seat, synthetic Finding Contract roles resolve `provider_routing.personas` by a fixed persona key rather than the configured persona name: `findings-manager` (manager), `supervisor` (conflict and terminal adjudication), and `loop-judge` (loop monitor judges). Escalated re-review has no persona routing. It fires only for a reviewer whose resolved profile declares `escalate` — the `escalation-reviewer` seat does not enable it — and it inherits the owning reviewer's step, taking its model from that seat when one is assigned and otherwise from the `escalate` target itself. Its reviewer key is the fixed string `escalation-reviewer`, which is a reserved workflow step name in every Finding Contract workflow.

### Auto Routing

Define `auto_routing` when TAKT should choose both provider and model from a candidate list. Its presence after global, project, and workflow config resolution enables automatic routing. Keep a concrete top-level provider/model for operations outside workflow steps and as the fallback when no effective `auto_routing` exists. The following example is for project `.takt/config.yaml` or global `~/.takt/config.yaml`:

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

A self-contained workflow may override routing with a workflow-level block. The workflow-level `auto_routing` block itself enables automatic routing for that workflow:

```yaml
workflow_config:
  provider: codex
  model: gpt-5.6-luna
auto_routing:
  strategy: balanced
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: coding
      provider: codex
      model: gpt-5.6-terra
      routing_tier: medium
      description: Implementation, testing, debugging, and refactoring
  default_pool: general
  candidate_pools:
    general:
      candidates: [coding]
      fallback: coding
```

Auto-routing candidate selection applies only to workflow step execution. Internal operations without workflow-step context, such as AI task-slug generation and sync conflict resolution, use the resolved concrete top-level provider/model. `auto_routing.router` and candidates are never implicit defaults.

Assistant conversations (interactive planning, instruct on existing tasks, and retry dialogue) do not go through auto routing. They resolve `takt_providers.assistant`, then fall back to the top-level provider/model when the assistant setting is unset; the assistant setting is not a default for other internal operations. CLI `--provider` / `--model` overrides apply to interactive planning only, while instruct and retry do not accept those overrides. Without a resolvable assistant or top-level provider, assistant startup fails with `Provider is not configured.`

Auto routing occupies the position shown in the complete provider/model priority above. Hard rules are checked in `tags`, `steps`, `personas` order. Otherwise `pool_rules` selects a candidate pool and the router estimates only the required tier; TAKT deterministically selects the candidate. After a successful estimate, both `cost` and `balanced` select the lowest `routing_tier` in the selected pool that meets the required tier. When multiple candidates have that tier, both strategies use their order in the pool's `candidates` list. `performance` selects the highest `routing_tier` in the selected pool. Estimator failures use that pool's explicit `fallback`. A successful estimate with no candidate at or above its required tier is an execution error.

Candidate `routing_tier` is limited to `high`, `medium`, or `low`. Every configuration requires `strategy`, `router` (with `provider` and `model`), at least one entry in `candidates`, `default_pool`, non-empty `candidate_pools`, and a pool-local `fallback`. The `router.model` and every candidate `model` must be a full model id containing a digit or a `/`; aliases such as `sonnet` are rejected by validation. Candidate `provider_options` are merged at step priority, so env/CLI-resolved option leaves still win. `model: auto` is not supported; use multiple candidates instead. CLI can override the strategy with `--auto-strategy cost|balanced|performance`; the override is propagated until execution reaches a workflow with effective `auto_routing`. If execution completes without reaching one, the strategy flag is ignored with a warning. The router receives normalized task, raw step instruction, and current remaining work; identifier redaction reduces identification risk but does not guarantee anonymity. Routing events remain local-only and do not contain routing text.

Routing decisions are local-only telemetry and are not recorded by default. When `telemetry.routing_decisions` is enabled (`takt telemetry enable` or `routing_decisions: true`), TAKT writes them as NDJSON under the project `.takt/events/` directory. TAKT does not upload routing decisions. Use `takt telemetry status`, `takt telemetry enable`, and `takt telemetry disable` to inspect or change only this local recording setting.

In workflow YAML, `model: null` is treated as an explicit entry-level value. It stops model resolution at the step, parallel sub-step, or `loop_monitors.judge`, so lower-priority sources and triggering-step inheritance are not consulted for `model`. Omitting the `model` field keeps normal fallback behavior.

`provider_options` priority is resolved per leaf. For most leaves, an env- or CLI-resolved config leaf overrides all other sources. `base_url` is the exception: step and workflow routing configuration stays above TAKT env overrides so a workflow can explicitly route only selected providers through a proxy. For `base_url`, the order is step `provider_options` > `provider_routing.steps` > `provider_routing.tags` > `provider_routing.personas` > deprecated `persona_providers` > `workflow_config.provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml` > TAKT env override. Preview, doctor, validation, summary, report, and other auxiliary entry points use the same `base_url` priority order as workflow execution. For other leaves, after env/CLI config overrides, the same step-to-global order applies.

For safety, workflow YAML and project `.takt/config.yaml` may only set `base_url` to loopback hosts such as `127.0.0.1`, `127.x.x.x`, `localhost`, `*.localhost`, or `::1`. Put non-loopback provider base URLs in global config or `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL` / `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL`, where the setting is user-controlled.

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

Workflow `provider_options.extends` can load shared YAML presets by name. Names are resolved first-match from `.takt/provider-options`, then `~/.takt/provider-options`, then `builtins/{lang}/provider-options`. For workflows installed from a repertoire package, the package-local `provider-options/` directory is checked before those locations. A scoped ref such as `@owner/repo/name` resolves `name` from another repertoire package's `provider-options/` directory. The resolved YAML is used as the base for the workflow or step layer where it is referenced, and inline `provider_options` in that same workflow or step override matching leaves.

`provider_options.extends` fails fast as a configuration error when a preset or path cannot be resolved, a scoped ref points to an unavailable repertoire package, the target YAML is invalid or is not a provider-options object, the extends chain is circular, or the removed `$ref` key is used. Relative paths are resolved from the workflow file and must stay inside the workflow directory after symlink resolution; absolute paths and paths whose real target escapes that directory are rejected.

Provider option leaves can also be overridden from env. For OpenCode model variants, use `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` to set `provider_options.opencode.variant`. For provider base URLs, use `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` or `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787`; these populate the config layer and do not override step or workflow routing `base_url` leaves. For Codex Skill inheritance, use `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_REPO=true` or `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_USER=true`. For Claude Skill inheritance, use `TAKT_PROVIDER_OPTIONS_CLAUDE_SKILLS_ENABLED=true`. For Claude terminal, use `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`, or `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500`. For Kiro custom agents, use `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` to set `provider_options.kiro.agent`.

This allows mixing providers and models within a single workflow while keeping display names independent from provider selection.

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

TAKT passes `provider_options.claude.base_url` to `claude` and `claude-sdk` as `ANTHROPIC_BASE_URL`. TAKT passes `provider_options.codex.base_url` to the Codex SDK constructor as `baseUrl`. `claude-terminal`, `opencode`, `cursor`, `copilot`, and `kiro` are not included in this base URL support unless documented separately.

Provider-native environment variables such as `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` are provider fallback settings. A TAKT `provider_options.*.base_url` value is explicit TAKT configuration and takes priority over those provider-native settings for the providers above.

This also works for routing through an external proxy or gateway service — any endpoint that speaks the OpenAI- or Anthropic-compatible API — as long as the URL is set at a layer allowed to use non-loopback hosts (global config or the `TAKT_PROVIDER_OPTIONS_*_BASE_URL` environment variables). The workflow and project layers accept loopback addresses only.

Workflow and project config can use `base_url` for local proxies only. Non-loopback proxy endpoints must be configured from global config or TAKT env so untrusted workflow files cannot redirect API keys and prompts to an arbitrary host.

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

`network_access` can be set at step / `provider_routing` / deprecated `persona_providers` / `workflow_config` / project / global levels, with step having the highest priority. The environment variable `TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS=true` also works as an override.

#### Codex Skill inheritance (`skills`)

TAKT workflows do not inherit repository or user Codex Skills by default. Enable either scope explicitly when a workflow should use those environment-dependent instructions. `takt exec` is the exception: each scope defaults to inheritance when that scope is not explicitly configured, and the resolved values are written into the generated `.takt/exec/workflow.yaml`. The Assistant dialogue and generated workflow therefore use the same snapshot, and direct reruns using that generated path retain it. A `TAKT_PROVIDER_OPTIONS_CODEX_SKILLS_*` environment override supplied to a later invocation remains higher priority and intentionally replaces the stored value.

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
    workflows: [default, simple]
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

Debug logs are written to `.takt/runs/debug-{timestamp}/logs/debug-{timestamp}.log` in NDJSON format, and prompt/response logs to `debug-{timestamp}-prompts.jsonl` in the same directory.

### Detailed Console Output

Enable detailed console output by setting `logging.level: debug`:

```yaml
# ~/.takt/config.yaml
logging:
  level: debug
```

This also enables the internal verbose console mode used by the CLI. `logging.level: debug` alone additionally enables the debug logger, so the `debug-{timestamp}.log` and `debug-{timestamp}-prompts.jsonl` artifacts above are produced without setting `logging.debug` separately. Any of `logging.debug: true`, `logging.trace: true`, or `logging.level: debug` enables them.

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

| Provider | Strict isolated companion execution | Implementer tool events |
|---|---:|---:|
| `claude-sdk` | Yes | Live |
| `codex` | Yes | Live |
| `claude` (headless) | Yes | Live |
| `claude-terminal` | Yes | Replayed after the turn |
| `mock` | Yes | Scenario-dependent |
| `opencode` | No | Live |
| `cursor`, `copilot`, `kiro` | No | Unavailable |

`No` means the workflow is rejected during loading; TAKT does not run a degraded, non-isolated companion.

When live tool events are unavailable, completion review and the same-session fix loop still run.
