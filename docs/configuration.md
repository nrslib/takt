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
notification_sound_events:    # Optional per-event toggles
  iteration_limit: false
  workflow_complete: true
  workflow_abort: true
  run_complete: true          # Enabled by default; set false to disable
  run_abort: true             # Enabled by default; set false to disable
concurrency: 1                # Parallel task count for takt run (1-10, default: 1 = sequential)
task_poll_interval_ms: 500    # Polling interval for new tasks during takt run (100-5000, default: 500)
interactive_preview_steps: 3  # Step previews in interactive mode (0-10, default: 3)
auto_requeue_max_attempts: 0  # Auto-requeue failed workflow tasks during takt run (non-negative integer, default: 0 = disabled)
ignore_exceed: false          # Applies to takt run and takt watch like --ignore-exceed (default: false)
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
# Routes the interactive planning conversation and the Report phase fallback provider.
# Report fallback uses this only after an OpenCode report retry fails.
# Project assistant overrides global assistant; when assistant is unset, TAKT does not
# fall back to top-level provider/model for report fallback.
# takt_providers:
#   assistant:
#     provider: claude
#     model: opus

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
#   routing_decisions: true       # Write auto-routing decisions to .takt/events/ (default: true)
```

### Global Config Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI language |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Log level |
| `provider` | `"auto"` \| `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | Default AI provider (`auto` = select provider/model through auto routing, `claude` = headless CLI mode, `claude-sdk` = SDK/API mode, `claude-terminal` = experimental interactive terminal mode) |
| `logging.trace` | boolean | `false` | Enable trace-level logging (suppresses high-frequency debug noise) |
| `model` | string | - | Default model name (passed to provider as-is) |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | Branch name generation strategy |
| `prevent_sleep` | boolean | `false` | Prevent macOS idle sleep (caffeinate) |
| `notification_sound` | boolean | `true` | Enable notification sounds |
| `notification_sound_events` | object | - | Per-event notification sound toggles |
| `concurrency` | number (1-10) | `1` | Parallel task count for `takt run` |
| `task_poll_interval_ms` | number (100-5000) | `500` | Polling interval for new tasks |
| `interactive_preview_steps` | number (0-10) | `3` | Step previews in interactive mode |
| `auto_requeue_max_attempts` | non-negative integer | `0` | Maximum automatic requeue attempts for failed workflow tasks during `takt run`; `0` disables automatic requeue |
| `ignore_exceed` | boolean | `false` | Configures iteration-limit bypass for `takt run` and `takt watch`; a CLI `--ignore-exceed` flag takes precedence when specified |
| `worktree_dir` | string | - | Directory for shared clones (defaults to `../{clone-name}`) |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `minimal_output` | boolean | `false` | Suppress AI output (for CI) |
| `runtime` | object | - | Runtime environment defaults (e.g., `prepare: [gradle, node]`) |
| `provider_routing` | object | - | Recommended workflow-step provider/model/provider_options routing by raw persona key, step tag, and step name |
| `persona_providers` | object | - | Deprecated legacy per-display-name provider/model/provider_options overrides. Prefer `provider_routing` for new settings |
| `provider_options` | object | - | Global provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |
| `anthropic_api_key` | string | - | Anthropic API key for Claude |
| `openai_api_key` | string | - | OpenAI API key for Codex |
| `opencode_api_key` | string | - | OpenCode API key |
| `cursor_api_key` | string | - | Cursor API key (optional; login session fallback supported) |
| `copilot_github_token` | string | - | GitHub token for Copilot CLI authentication |
| `kiro_api_key` | string | - | Kiro API key |
| `codex_cli_path` | string | - | Codex CLI binary path override (absolute) |
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
| `takt_providers` | object | - | TAKT internal provider overrides. `assistant` routes the interactive planning conversation and is also used as the Report phase fallback provider after an OpenCode report retry fails. Project `takt_providers.assistant` overrides global `takt_providers.assistant`; if neither is set, Report phase fallback is disabled and top-level `provider` / `model` are not used as an implicit fallback. |
| `telemetry` | object | `{ routing_decisions: true }` | Local-only routing decision recording. `telemetry.routing_decisions` controls whether auto-routing decisions are written as NDJSON under the project `.takt/events/` directory. TAKT does not upload routing decisions. |
| `workflow_mcp_servers` | object | all `false` | MCP server transport policy (`stdio`, `sse`, `http` toggles) |
| `workflow_arpeggio` | object | all `false` | Arpeggio custom code policy (`custom_data_source_modules`, `custom_merge_inline_js`, `custom_merge_files`) |
| `workflow_runtime_prepare` | object | `{ custom_scripts: false }` | Runtime prepare policy (builtin presets always allowed) |
| `workflow_command_gates` | object | `{ custom_scripts: false }` | Workflow YAML command quality gate policy |
| `sync_conflict_resolver` | object | `{ auto_approve_tools: false }` | Sync conflict resolver policy |
| `observability` | object | disabled | Opt-in OpenTelemetry foundation. `enabled` initializes the SDK, `monitor` writes workflow metrics to `.takt/runs/<run>/monitor.json`, `session_log_exporter` writes a shadow session log from spans, and `usage_events_phase` writes phase-level usage events to `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl`. With `enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT`, TAKT also sends spans and metrics through OTLP using standard `OTEL_EXPORTER_OTLP_*` environment variables; TAKT does not add an OTLP config key. |

## Project Configuration

Configure project-specific settings in `.takt/config.yaml`. This file is created when you first use TAKT in a project directory.

```yaml
# .takt/config.yaml
provider: claude              # Override provider for this project
model: sonnet                 # Override model for this project
auto_pr: true                 # Auto-create PR after worktree execution
logging:
  level: info                 # Console log level: debug | info | warn | error
concurrency: 2                # Parallel task count for takt run in this project (1-10)
auto_requeue_max_attempts: 1  # Auto-requeue failed workflow tasks during takt run (non-negative integer)
ignore_exceed: false          # Applies to takt run and takt watch like --ignore-exceed
# base_branch: main           # Base branch for clone creation (overrides global, default: remote default branch)

# Explicit initial context files for interactive assistant mode only (project config only)
# assistant:
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

### Project Config Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"auto"` \| `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | Override provider |
| `model` | string | - | Override model name (passed to provider as-is) |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `concurrency` | number (1-10) | `1` (from global) | Parallel task count for `takt run` |
| `auto_requeue_max_attempts` | non-negative integer | `0` (from global/default) | Maximum automatic requeue attempts for failed workflow tasks during `takt run`; `0` disables automatic requeue |
| `ignore_exceed` | boolean | `false` (from global/default) | Configures iteration-limit bypass for `takt run` and `takt watch`; a CLI `--ignore-exceed` flag takes precedence when specified |
| `base_branch` | string | - | Base branch for clone creation (overrides global, default: remote default branch) |
| `assistant.init_files` | string[] | - | Project-only interactive assistant initial context files. Paths must be relative to the project root; absolute paths, paths resolving outside the project root, and sensitive file patterns such as `.env*`, `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`, and `.git/**` are rejected. Missing paths, directories, and unreadable files fail with a clear error. At most 16 files are allowed; each file is limited to 256 KiB and the combined content is limited to 1 MiB. When unset or empty, TAKT does not auto-discover `CLAUDE.md`, `AGENT.md`, `AGENTS.md`, `TAKT.md`, or other files. This is separate from `takt_providers.assistant`, which only controls the assistant provider/model. |
| `provider_options` | object | - | Provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |
| `vcs_provider` | `"github"` \| `"gitlab"` | auto-detect | VCS provider (overrides global) |
| `takt_providers` | object | - | TAKT internal provider overrides. Project `takt_providers.assistant` overrides the global assistant provider/model and is used for the interactive planning conversation and Report phase fallback after an OpenCode report retry fails. If project and global assistant are both unset, Report phase fallback is disabled and top-level `provider` / `model` are not used as an implicit fallback. |
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

TAKT resolves model selection in two stages:

1. **Base input model** - Before workflow execution starts, the input `model` is resolved from CLI `--model`, then config `model`, then the provider default.
2. **Workflow step model** - For each workflow step, the effective model is resolved from step YAML `model`, then `provider_routing.steps.<step.name>`, then matching `provider_routing.tags` in the order written on the step, then `provider_routing.personas.<raw persona key>`, then deprecated `persona_providers.<persona display name>`, then `workflow_config.model`, then the already-resolved input `model`.

For Finding Contract workflows, `finding_contract.manager.provider` and `finding_contract.manager.model` are treated as step-level provider/model values for the synthetic `findings-manager` step. They override `provider_routing`, deprecated `persona_providers.findings-manager`, workflow defaults, and resolved input values. When neither field is set, the manager uses the same fallback chain as any other workflow step. Setting only `provider` stops lower-priority model fallback, so the selected provider uses its own default; providers that require an explicit model fail validation.

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
# workflow.yaml - step-level override takes highest priority
steps:
  - name: plan
    model: opus       # This step uses opus regardless of global config
    ...
  - name: implement
    # No model specified - falls back to global config (opus)
    ...
```

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

For `provider` / `model`, workflow step resolution priority is:

```text
step YAML provider/model
> provider_routing.steps.<step.name>
> provider_routing.tags.<tag>
> provider_routing.personas.<raw persona key>
> persona_providers.<persona display name>  # deprecated legacy
> workflow_config.provider/model
> resolved input
```

The resolved input is determined before workflow execution from CLI flags, then project `.takt/config.yaml`, then global `~/.takt/config.yaml`, then the provider default. Promotion entries, when active, are higher priority than the step YAML value.

For the Finding Contract manager, `finding_contract.manager.provider` and `finding_contract.manager.model` occupy the `step YAML provider/model` position for the synthetic `findings-manager` step.

### Auto Routing

Set `provider: auto` when TAKT should choose both provider and model from an effective `auto_routing` candidate list. The following example is for project `.takt/config.yaml` or global `~/.takt/config.yaml`:

```yaml
provider: auto

takt_providers:
  assistant:
    provider: codex
    model: gpt-5.6-sol

auto_routing:
  default_provider:
    provider: codex
    model: gpt-5.6-luna # optional; omit to use the provider's default model
  strategy: balanced # cost | balanced | performance
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: advanced
      description: Planning, final decisions, requirement-fulfillment judgment, and other advanced reasoning
      provider: codex
      model: gpt-5.6-sol
      cost_tier: high
    - name: coding
      description: Implementation, tests, debugging, and refactoring
      provider: codex
      model: gpt-5.6-terra
      cost_tier: medium
    - name: lightweight
      description: Formatting and small mechanical edits
      provider: codex
      model: gpt-5.6-luna
      cost_tier: low
  rules:
    tags:
      implementation: coding
      architecture: advanced
    steps:
      security-audit: advanced
    personas:
      architect: advanced
```

A self-contained workflow may override routing with a workflow-level block. Workflow YAML uses only routing fields and does not accept the config-only `default_provider` field:

```yaml
workflow_config:
  provider: auto
auto_routing:
  strategy: balanced
  router:
    provider: codex
    model: gpt-5.6-luna
  candidates:
    - name: coding
      provider: codex
      model: gpt-5.6-terra
      cost_tier: medium
      description: Implementation, testing, debugging, and refactoring
```

When the effective top-level provider is `auto`, TAKT uses `auto_routing.default_provider` for internal operations that need a concrete provider but have no workflow step context, such as AI task-slug generation. `default_provider.provider` is required and cannot be `auto`; `default_provider.model` is optional. The project `default_provider` takes precedence over the global value as a whole object, so its `provider` and `model` are not merged with fields from the global object. If this setting is missing when such an operation runs, TAKT reports `Configuration error: auto_routing.default_provider is required when provider is auto for operations without workflow step context.` A concrete effective top-level provider continues to use its top-level provider/model.

Auto-routing candidate selection applies to workflow step execution only. `auto_routing.router` is only for routing decisions and is never used implicitly as `default_provider`. The interactive assistant does not go through auto routing and continues to use `takt_providers.assistant`; that assistant setting is not used as the default for other internal operations. A top-level `provider: auto` is ignored for the assistant, so pair it with `takt_providers.assistant` (or pass `--provider` on the CLI). Without either, assistant startup fails with `Provider is not configured.`

Resolution order stays conservative: `promotion`, explicit step provider/model, `provider_routing`, and `persona_providers` win before auto routing. Auto routing then checks rules in `tags`, `steps`, `personas` order. If multiple step tags match, the later tag on the step wins. If no rule matches, TAKT asks the configured router model to select a candidate from descriptions; router failures log a warning and fall back to the strategy default: `cost` chooses the first `low` candidate, `balanced` the first `medium`, and `performance` the first `high`.

Candidate `cost_tier` is limited to `high`, `medium`, or `low`. Candidate `provider_options` are merged at step priority, so env/CLI-resolved option leaves still win. `model: auto` is not supported; use multiple candidates instead. CLI can override the strategy with `--auto-strategy cost|balanced|performance`; the override applies when the effective workflow, step, parallel sub-step, workflow_call override, or resolved workflow_call child uses `provider: auto`. When no auto provider path is present, the strategy flag is ignored with a warning.

Routing decisions are local-only telemetry. When `telemetry.routing_decisions` is enabled, TAKT writes them as NDJSON under the project `.takt/events/` directory. TAKT does not upload routing decisions. Use `takt telemetry status`, `takt telemetry enable`, and `takt telemetry disable` to inspect or change only this local recording setting.

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

Provider option leaves can also be overridden from env. For OpenCode model variants, use `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` to set `provider_options.opencode.variant`. For provider base URLs, use `TAKT_PROVIDER_OPTIONS_CODEX_BASE_URL=http://127.0.0.1:8787/v1` or `TAKT_PROVIDER_OPTIONS_CLAUDE_BASE_URL=http://127.0.0.1:8787`; these populate the config layer and do not override step or workflow routing `base_url` leaves. For Claude terminal, use `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`, or `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500`. For Kiro custom agents, use `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` to set `provider_options.kiro.agent`.

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

Use only **`workflow_categories`** and **`workflows`** in category configuration files.

### Configuration

Categories can be configured in:
- `builtins/{lang}/workflow-categories.yaml` — default builtin categories (bundled with TAKT)
- `~/.takt/config.yaml` or a separate file via `workflow_categories_file` (default user overlay: `~/.takt/preferences/workflow-categories.yaml`)

```yaml
# ~/.takt/config.yaml or dedicated categories file (canonical)
workflow_categories:
  Development:
    workflows: [default, simple]
    children:
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

- **Nested categories** — unlimited depth for hierarchical organization
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
| `--skip-git` | Skip branch creation, commit, and push (workflow-only) |
| `--repo <owner/repo>` | Repository for PR creation |
| `-q, --quiet` | Minimal output mode (suppress AI output) |

## Debugging

### Debug Logging

Enable debug logging by setting `logging.debug: true` in `~/.takt/config.yaml`:

```yaml
logging:
  debug: true
```

Debug logs are written to `.takt/runs/debug-{timestamp}/logs/debug.log` in NDJSON format.

### Detailed Console Output

Enable detailed console output by setting `logging.level: debug` in your config:

```yaml
# ~/.takt/config.yaml or .takt/config.yaml
logging:
  level: debug
```

This also enables the internal verbose console mode used by the CLI.

If you want debug artifacts such as `debug.log`, enable them explicitly:

```yaml
logging:
  debug: true
```
