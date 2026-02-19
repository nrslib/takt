# Configuration

[日本語](./configuration.ja.md)

This document is a reference for all TAKT configuration options. For a quick start, see the main [README](../README.md).

## Global Configuration

Configure TAKT defaults in `~/.takt/config.yaml`. This file is created automatically on first run. All fields are optional.

```yaml
# ~/.takt/config.yaml
language: en                  # UI language: 'en' or 'ja'
default_piece: default        # Default piece for new projects
log_level: info               # Log level: debug, info, warn, error
provider: claude              # Default provider: claude, codex, or opencode
model: sonnet                 # Default model (optional, passed to provider as-is)
branch_name_strategy: romaji  # Branch name generation: 'romaji' (fast) or 'ai' (slow)
prevent_sleep: false          # Prevent macOS idle sleep during execution (caffeinate)
notification_sound: true      # Enable/disable notification sounds
notification_sound_events:    # Optional per-event toggles
  iteration_limit: false
  piece_complete: true
  piece_abort: true
  run_complete: true          # Enabled by default; set false to disable
  run_abort: true             # Enabled by default; set false to disable
concurrency: 1                # Parallel task count for takt run (1-10, default: 1 = sequential)
task_poll_interval_ms: 500    # Polling interval for new tasks during takt run (100-5000, default: 500)
interactive_preview_movements: 3  # Movement previews in interactive mode (0-10, default: 3)

# Runtime environment defaults (applies to all pieces unless piece_config.runtime overrides)
# runtime:
#   prepare:
#     - gradle    # Prepare Gradle cache/config in .runtime/
#     - node      # Prepare npm cache in .runtime/

# Per-persona provider/model overrides (optional)
# Route specific personas to different providers and models without duplicating pieces
# persona_providers:
#   coder:
#     provider: codex        # Run coder on Codex
#     model: o3-mini         # Use o3-mini model (optional)
#   ai-antipattern-reviewer:
#     provider: claude       # Keep reviewers on Claude

# Provider-specific permission profiles (optional)
# Priority: project override > global override > project default > global default > required_permission_mode (floor)
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     movement_permission_overrides:
#       ai_review: readonly
#   claude:
#     default_permission_mode: edit

# API Key configuration (optional)
# Can be overridden by environment variables TAKT_ANTHROPIC_API_KEY / TAKT_OPENAI_API_KEY / TAKT_OPENCODE_API_KEY
# anthropic_api_key: sk-ant-...  # For Claude (Anthropic)
# openai_api_key: sk-...         # For Codex (OpenAI)
# opencode_api_key: ...          # For OpenCode

# Codex CLI path override (optional)
# Override the Codex CLI binary used by the Codex SDK (must be an absolute path to an executable file)
# Can be overridden by TAKT_CODEX_CLI_PATH environment variable
# codex_cli_path: /usr/local/bin/codex

# Builtin piece filtering (optional)
# builtin_pieces_enabled: true           # Set false to disable all builtins
# disabled_builtins: [magi, passthrough] # Disable specific builtin pieces

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
| `default_piece` | string | `"default"` | Default piece for new projects |
| `log_level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Log level |
| `provider` | `"claude"` \| `"codex"` \| `"opencode"` | `"claude"` | Default AI provider |
| `model` | string | - | Default model name (passed to provider as-is) |
| `branch_name_strategy` | `"romaji"` \| `"ai"` | `"romaji"` | Branch name generation strategy |
| `prevent_sleep` | boolean | `false` | Prevent macOS idle sleep (caffeinate) |
| `notification_sound` | boolean | `true` | Enable notification sounds |
| `notification_sound_events` | object | - | Per-event notification sound toggles |
| `concurrency` | number (1-10) | `1` | Parallel task count for `takt run` |
| `task_poll_interval_ms` | number (100-5000) | `500` | Polling interval for new tasks |
| `interactive_preview_movements` | number (0-10) | `3` | Movement previews in interactive mode |
| `worktree_dir` | string | - | Directory for shared clones (defaults to `../{clone-name}`) |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `verbose` | boolean | - | Verbose output mode |
| `minimal_output` | boolean | `false` | Suppress AI output (for CI) |
| `runtime` | object | - | Runtime environment defaults (e.g., `prepare: [gradle, node]`) |
| `persona_providers` | object | - | Per-persona provider/model overrides (e.g., `coder: { provider: codex, model: o3-mini }`) |
| `provider_options` | object | - | Global provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |
| `anthropic_api_key` | string | - | Anthropic API key for Claude |
| `openai_api_key` | string | - | OpenAI API key for Codex |
| `opencode_api_key` | string | - | OpenCode API key |
| `codex_cli_path` | string | - | Codex CLI binary path override (absolute) |
| `enable_builtin_pieces` | boolean | `true` | Enable builtin pieces |
| `disabled_builtins` | string[] | `[]` | Specific builtin pieces to disable |
| `pipeline` | object | - | Pipeline template settings |
| `bookmarks_file` | string | - | Path to bookmarks file |
| `piece_categories_file` | string | - | Path to piece categories file |

## Project Configuration

Configure project-specific settings in `.takt/config.yaml`. This file is created when you first use TAKT in a project directory.

```yaml
# .takt/config.yaml
piece: default                # Current piece for this project
provider: claude              # Override provider for this project
auto_pr: true                 # Auto-create PR after worktree execution
verbose: false                # Verbose output mode

# Provider-specific options (overrides global, overridden by piece/movement)
# provider_options:
#   codex:
#     network_access: true

# Provider-specific permission profiles (project-level override)
# provider_profiles:
#   codex:
#     default_permission_mode: full
#     movement_permission_overrides:
#       ai_review: readonly
```

### Project Config Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `piece` | string | `"default"` | Current piece name for this project |
| `provider` | `"claude"` \| `"codex"` \| `"opencode"` \| `"mock"` | - | Override provider |
| `auto_pr` | boolean | - | Auto-create PR after worktree execution |
| `verbose` | boolean | - | Verbose output mode |
| `provider_options` | object | - | Provider-specific options |
| `provider_profiles` | object | - | Provider-specific permission profiles |

Project config values override global config when both are set.

## API Key Configuration

TAKT supports three providers, each with its own API key. API keys can be configured via environment variables or `~/.takt/config.yaml`.

### Environment Variables (Recommended)

```bash
# For Claude (Anthropic)
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# For Codex (OpenAI)
export TAKT_OPENAI_API_KEY=sk-...

# For OpenCode
export TAKT_OPENCODE_API_KEY=...
```

### Config File

```yaml
# ~/.takt/config.yaml
anthropic_api_key: sk-ant-...  # For Claude
openai_api_key: sk-...         # For Codex
opencode_api_key: ...          # For OpenCode
```

### Priority

Environment variables take precedence over `config.yaml` settings.

| Provider | Environment Variable | Config Key |
|----------|---------------------|------------|
| Claude (Anthropic) | `TAKT_ANTHROPIC_API_KEY` | `anthropic_api_key` |
| Codex (OpenAI) | `TAKT_OPENAI_API_KEY` | `openai_api_key` |
| OpenCode | `TAKT_OPENCODE_API_KEY` | `opencode_api_key` |

### Security

- If you write API keys in `config.yaml`, be careful not to commit this file to Git.
- Consider using environment variables instead.
- Add `~/.takt/config.yaml` to your global `.gitignore` if needed.
- If you set an API key, installing the corresponding CLI tool (Claude Code, Codex, OpenCode) is not necessary. TAKT directly calls the respective API.

### Codex CLI Path Override

You can override the Codex CLI binary path using either an environment variable or config:

```bash
export TAKT_CODEX_CLI_PATH=/usr/local/bin/codex
```

```yaml
# ~/.takt/config.yaml
codex_cli_path: /usr/local/bin/codex
```

The path must be an absolute path to an executable file. `TAKT_CODEX_CLI_PATH` takes precedence over the config file value.

## Model Resolution

The model used for each movement is resolved with the following priority order (highest first):

1. **Piece movement `model`** - Specified in the movement definition in piece YAML
2. **Custom agent `model`** - Agent-level model in `.takt/agents.yaml`
3. **Global config `model`** - Default model in `~/.takt/config.yaml`
4. **Provider default** - Falls back to the provider's built-in default (Claude: `sonnet`, Codex: `codex`, OpenCode: provider default)

### Provider-specific Model Notes

**Claude Code** supports aliases (`opus`, `sonnet`, `haiku`, `opusplan`, `default`) and full model names (e.g., `claude-sonnet-4-5-20250929`). The `model` field is passed directly to the provider CLI. Refer to the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) for available models.

**Codex** uses the model string as-is via the Codex SDK. If unspecified, defaults to `codex`. Refer to Codex documentation for available models.

**OpenCode** requires a model in `provider/model` format (e.g., `opencode/big-pickle`). Omitting the model for the OpenCode provider will result in a configuration error.

### Example

```yaml
# ~/.takt/config.yaml
provider: claude
model: opus     # Default model for all movements (unless overridden)
```

```yaml
# piece.yaml - movement-level override takes highest priority
movements:
  - name: plan
    model: opus       # This movement uses opus regardless of global config
    ...
  - name: implement
    # No model specified - falls back to global config (opus)
    ...
```

## Provider Profiles

Provider profiles allow you to set default permission modes and per-movement permission overrides for each provider. This is useful when running different providers with different security postures.

### Permission Modes

TAKT uses three provider-independent permission modes:

| Mode | Description | Claude | Codex | OpenCode |
|------|-------------|--------|-------|----------|
| `readonly` | Read-only access, no file modifications | `default` | `read-only` | `read-only` |
| `edit` | Allow file edits with confirmation | `acceptEdits` | `workspace-write` | `workspace-write` |
| `full` | Bypass all permission checks | `bypassPermissions` | `danger-full-access` | `danger-full-access` |

### Configuration

Provider profiles can be set at both global and project levels:

```yaml
# ~/.takt/config.yaml (global) or .takt/config.yaml (project)
provider_profiles:
  codex:
    default_permission_mode: full
    movement_permission_overrides:
      ai_review: readonly
  claude:
    default_permission_mode: edit
    movement_permission_overrides:
      implement: full
```

### Permission Resolution Priority

Permission mode is resolved in the following order (first match wins):

1. **Project** `provider_profiles.<provider>.movement_permission_overrides.<movement>`
2. **Global** `provider_profiles.<provider>.movement_permission_overrides.<movement>`
3. **Project** `provider_profiles.<provider>.default_permission_mode`
4. **Global** `provider_profiles.<provider>.default_permission_mode`
5. **Movement** `required_permission_mode` (acts as a minimum floor)

The `required_permission_mode` on a movement sets the minimum floor. If the resolved mode from provider profiles is lower than the required mode, the required mode is used instead. For example, if a movement requires `edit` but the profile resolves to `readonly`, the effective mode will be `edit`.

### Persona Providers

Route specific personas to different providers and models without duplicating pieces:

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder:
    provider: codex        # Run coder persona on Codex
    model: o3-mini         # Use o3-mini model (optional)
  ai-antipattern-reviewer:
    provider: claude       # Keep reviewers on Claude
```

Both `provider` and `model` are optional. `model` resolution priority: movement YAML `model` > `persona_providers[persona].model` > global `model`.

This allows mixing providers and models within a single piece. The persona name is matched against the `persona` key in the movement definition.

## Piece Categories

Organize pieces into categories for better UI presentation in `takt switch` and piece selection prompts.

### Configuration

Categories can be configured in:
- `builtins/{lang}/piece-categories.yaml` - Default builtin categories
- `~/.takt/config.yaml` or a separate categories file specified by `piece_categories_file`

```yaml
# ~/.takt/config.yaml or dedicated categories file
piece_categories:
  Development:
    pieces: [default, simple]
    children:
      Backend:
        pieces: [expert-cqrs]
      Frontend:
        pieces: [expert]
  Research:
    pieces: [research, magi]

show_others_category: true         # Show uncategorized pieces (default: true)
others_category_name: "Other Pieces"  # Name for uncategorized category
```

### Category Features

- **Nested categories** - Unlimited depth for hierarchical organization
- **Per-category piece lists** - Assign pieces to specific categories
- **Others category** - Automatically collects uncategorized pieces (can be disabled via `show_others_category: false`)
- **Builtin piece filtering** - Disable all builtins via `enable_builtin_pieces: false`, or selectively via `disabled_builtins: [name1, name2]`

### Resetting Categories

Reset piece categories to builtin defaults:

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
| `{report}` | PR body | Piece execution report |

### Pipeline CLI Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode |
| `--auto-pr` | Create PR after execution |
| `--skip-git` | Skip branch creation, commit, and push (piece-only) |
| `--repo <owner/repo>` | Repository for PR creation |
| `-q, --quiet` | Minimal output mode (suppress AI output) |

## Debugging

### Debug Logging

Enable debug logging by setting `debug_enabled: true` in `~/.takt/config.yaml` or by creating a `.takt/debug.yaml` file:

```yaml
# .takt/debug.yaml
enabled: true
```

Debug logs are written to `.takt/logs/debug.log` in NDJSON format.

### Verbose Mode

Create an empty `.takt/verbose` file to enable verbose console output. This automatically enables debug logging.

Alternatively, set `verbose: true` in your config:

```yaml
# ~/.takt/config.yaml or .takt/config.yaml
verbose: true
```
