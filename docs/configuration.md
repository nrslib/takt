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
# auto_fetch: false           # Fetch remote before cloning (default: false)
# base_branch: main           # Base branch for clone creation (default: remote default branch)

# Runtime environment defaults (applies to all workflows unless workflow_config.runtime overrides)
# runtime:
#   prepare:
#     - gradle    # Prepare Gradle cache/config in .runtime/
#     - node      # Prepare npm cache in .runtime/

# Per-persona provider/model/provider_options overrides (optional)
# Route specific personas to different providers and models without duplicating workflows
# persona_providers:
#   coder:
#     provider: codex        # Run coder on Codex
#     model: o3-mini         # Use o3-mini model (optional)
#     provider_options:
#       codex:
#         reasoning_effort: high
#   ai-antipattern-reviewer:
#     provider: claude       # Keep reviewers on Claude
#     provider_options:
#       claude:
#         effort: high

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

# Interactive assistant provider (optional)
# Route the interactive planning conversation to a separate provider/model
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
```

### Global Config Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `language` | `"en"` \| `"ja"` | `"en"` | UI language |
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Log level |
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | `"claude"` | Default AI provider (`claude` = headless CLI mode, `claude-sdk` = SDK/API mode, `claude-terminal` = experimental interactive terminal mode) |
| `logging.trace` | boolean | `false` | Enable trace-level logging (suppresses high-frequency debug noise) |
| `model` | string | - | Default model name (passed to provider as-is) |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | Branch name generation strategy |
| `prevent_sleep` | boolean | `false` | Prevent macOS idle sleep (caffeinate) |
| `notification_sound` | boolean | `true` | Enable notification sounds |
| `notification_sound_events` | object | - | Per-event notification sound toggles |
| `concurrency` | number (1-10) | `1` | Parallel task count for `takt run` |
| `task_poll_interval_ms` | number (100-5000) | `500` | Polling interval for new tasks |
| `interactive_preview_steps` | number (0-10) | `3` | Step previews in interactive mode |
| `worktree_dir` | string | - | Directory for shared clones (defaults to `../{clone-name}`) |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `minimal_output` | boolean | `false` | Suppress AI output (for CI) |
| `runtime` | object | - | Runtime environment defaults (e.g., `prepare: [gradle, node]`) |
| `persona_providers` | object | - | Per-persona provider/model/provider_options overrides (e.g., `coder: { provider: codex, model: o3-mini, provider_options: { codex: { reasoning_effort: high } } }`) |
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
| `takt_providers` | object | - | TAKT internal provider overrides (e.g., `assistant: { provider: claude, model: opus }`) |
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
# base_branch: main           # Base branch for clone creation (overrides global, default: remote default branch)

# Explicit initial context files for interactive assistant mode only (project config only)
# assistant:
#   init_files:
#     - docs/assistant-context.md
#     - .takt/assistant-notes.md

# Provider-specific options (project defaults; env-resolved leaf overrides win, otherwise step > workflow > persona > project > global)
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
| `provider` | `"claude"` \| `"claude-sdk"` \| `"claude-terminal"` \| `"codex"` \| `"opencode"` \| `"cursor"` \| `"copilot"` \| `"kiro"` \| `"mock"` | - | Override provider |
| `model` | string | - | Override model name (passed to provider as-is) |
| `allow_git_hooks` | boolean | `false` | Allow git hooks during TAKT-managed auto-commit |
| `allow_git_filters` | boolean | `false` | Allow git filters during TAKT-managed auto-commit |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `concurrency` | number (1-10) | `1` (from global) | Parallel task count for `takt run` |
| `base_branch` | string | - | Base branch for clone creation (overrides global, default: remote default branch) |
| `assistant.init_files` | string[] | - | Project-only interactive assistant initial context files. Paths must be relative to the project root; absolute paths, paths resolving outside the project root, and sensitive file patterns such as `.env*`, `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`, and `.git/**` are rejected. Missing paths, directories, and unreadable files fail with a clear error. At most 16 files are allowed; each file is limited to 256 KiB and the combined content is limited to 1 MiB. When unset or empty, TAKT does not auto-discover `CLAUDE.md`, `AGENT.md`, `AGENTS.md`, `TAKT.md`, or other files. This is separate from `takt_providers.assistant`, which only controls the assistant provider/model. |
| `provider_options` | object | - | Provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |
| `vcs_provider` | `"github"` \| `"gitlab"` | auto-detect | VCS provider (overrides global) |
| `takt_providers` | object | - | TAKT internal provider overrides (e.g., `assistant: { provider: claude, model: opus }`) |
| `workflow_mcp_servers` | object | - | MCP server transport policy (overrides global) |
| `workflow_arpeggio` | object | - | Arpeggio custom code policy (overrides global) |
| `workflow_runtime_prepare` | object | - | Runtime prepare policy (overrides global) |
| `workflow_command_gates` | object | - | Workflow YAML command quality gate policy (overrides global) |
| `sync_conflict_resolver` | object | - | Sync conflict resolver policy (overrides global) |
| `observability` | object | - | Project-level OpenTelemetry opt-in override. `enabled` initializes the SDK, `monitor` writes workflow metrics to `.takt/runs/<run>/monitor.json`, `session_log_exporter` writes a shadow session log from spans, and `usage_events_phase` writes phase-level usage events to `.takt/runs/<run>/logs/<session>-usage-events.phase.jsonl`. With `enabled: true` and `OTEL_EXPORTER_OTLP_ENDPOINT`, TAKT also sends spans and metrics through OTLP using standard `OTEL_EXPORTER_OTLP_*` environment variables; TAKT does not add an OTLP config key. |

Project config values override global config when both are set.

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
2. **Workflow step model** - For each workflow step, the effective model is resolved from step YAML `model`, then `persona_providers[persona].model`, then the already-resolved input `model`.

### Provider-specific Model Notes

**Claude Code** supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). The `model` field is passed directly to the provider CLI. Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

**Codex** uses the model string as-is via the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

**OpenCode** requires a model in `provider/model` format (e.g., `opencode/big-pickle`). Omitting the model for the OpenCode provider will result in a configuration error.

**Cursor Agent** forwards `model` directly to `cursor-agent --model <model>`. If omitted, Cursor CLI default is used.

**GitHub Copilot CLI** forwards `model` directly to `copilot --model <model>`. If omitted, Copilot CLI default is used.

**Kiro CLI** does not receive `model` as a CLI flag in the initial implementation. Configure Kiro's default model on the Kiro side.

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

### Persona Providers

Route specific personas to different providers, models, and provider-specific options without duplicating workflows. You can define this in either `~/.takt/config.yaml` or `.takt/config.yaml`:

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder:
    provider: codex        # Run coder persona on Codex
    model: o3-mini         # Use o3-mini model (optional)
    provider_options:
      codex:
        reasoning_effort: high
  ai-antipattern-reviewer:
    provider: claude       # Keep reviewers on Claude
    provider_options:
      claude:
        effort: high
```

`provider`, `model`, and `provider_options` are individually optional, but each persona entry must include at least one of them. Empty `provider_options` objects are rejected. In workflow step resolution, `provider` / `model` priority is step YAML > `persona_providers[persona]` > resolved input. That input is resolved before workflow execution from CLI flags, then config, then the provider default.

`provider_options` priority is resolved per leaf. An env-resolved config leaf overrides all other sources. Otherwise the order is: step `provider_options` > workflow `workflow_config.provider_options` > `persona_providers[persona].provider_options` > project `.takt/config.yaml` > global `~/.takt/config.yaml`.

Provider option leaves can also be overridden from env. For OpenCode model variants, use `TAKT_PROVIDER_OPTIONS_OPENCODE_VARIANT=high` to set `provider_options.opencode.variant`. For Claude terminal, use `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_BACKEND=tmux`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TIMEOUT_MS=900000`, `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_KEEP_SESSION=false`, or `TAKT_PROVIDER_OPTIONS_CLAUDE_TERMINAL_TRANSCRIPT_POLL_INTERVAL_MS=500`. For Kiro custom agents, use `TAKT_PROVIDER_OPTIONS_KIRO_AGENT=planner-agent` to set `provider_options.kiro.agent`.

This allows mixing providers and models within a single workflow. The persona name is matched against the `persona` key in the step definition.

### Provider-specific options in practice

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

`network_access` can be set at step / `workflow_config` / `persona_providers` / project / global levels, with step having the highest priority. The environment variable `TAKT_PROVIDER_OPTIONS_CODEX_NETWORK_ACCESS=true` also works as an override.

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
