# Provider Sandbox & Permission Configuration

TAKT orchestrates multiple AI agent providers, each with different sandbox mechanisms and security models. This guide explains how sandbox isolation works, how to configure permissions and network access, and the security trade-offs you should understand.

## Overview

| Provider | Sandbox Mechanism | Network Default | TAKT Configuration |
|----------|------------------|-----------------|-------------------|
| **Claude Code** | macOS Seatbelt / Linux bubblewrap | Blocked in `edit` mode | `provider_options.claude.sandbox` |
| **Codex CLI** | macOS Seatbelt / Linux Landlock+seccomp | Blocked | `provider_options.codex.network_access` |
| **OpenCode CLI** | None (no native sandbox) | Unrestricted | `provider_options.opencode.network_access` |
| **Cursor Agent** | None (relies on Cursor IDE sandbox) | Unrestricted | N/A |
| **GitHub Copilot CLI** | None (no native sandbox) | Unrestricted | N/A |

## Permission Modes

TAKT uses three provider-independent permission modes. Each mode maps to provider-specific settings automatically.

| TAKT Mode | Claude Code | Codex CLI | OpenCode |
|-----------|------------|-----------|----------|
| `readonly` | `default` | `read-only` | All tools denied |
| `edit` | `acceptEdits` | `workspace-write` | Read/edit/bash tools allowed |
| `full` | `bypassPermissions` | `danger-full-access` | All tools allowed |

### What each mode means

**`readonly`** — The agent can read files and search code, but cannot modify anything. Use for review movements where the agent only needs to analyze code.

**`edit`** — The agent can read and edit files within the working directory. Bash commands run inside the provider's sandbox (if available). This is the recommended default for implementation movements.

**`full`** — All restrictions are removed. The agent has unrestricted access to the filesystem, network, and system commands. See [Security considerations for `full` mode](#security-considerations-for-full-mode).

### Configuring permission modes

Set default permission modes per provider via `provider_profiles` in `~/.takt/config.yaml` or `.takt/config.yaml`:

```yaml
provider_profiles:
  codex:
    default_permission_mode: edit
  claude:
    default_permission_mode: edit
```

You can also override permissions for specific movements:

```yaml
provider_profiles:
  codex:
    default_permission_mode: edit
    movement_permission_overrides:
      implement: full      # Only the implement movement gets full access
      ai_review: readonly  # Review stays read-only
```

See [Configuration — Provider Profiles](./configuration.md#provider-profiles) for the full resolution priority.

## Codex CLI Sandbox

### How the Codex sandbox works

Codex CLI runs commands inside an OS-level sandbox:

- **macOS**: Uses Seatbelt (`sandbox-exec`) with sandbox profiles
- **Linux**: Uses Landlock + seccomp (with optional bwrap)

By default, the sandbox enforces two key restrictions:

1. **Network access is blocked** — All outbound connections are denied
2. **Filesystem writes are scoped** — Only the working directory and `/tmp` are writable; `.git` is always read-only

### Why you need `network_access: true`

With network access blocked by default, the following operations fail inside the Codex sandbox:

- `npm install`, `yarn install`, `pnpm install` — Cannot download packages
- `pip install`, `poetry install` — Cannot download Python packages
- `./gradlew build`, `mvn install` — Cannot download dependencies
- `curl`, `wget`, `gh api` — Cannot reach external APIs
- Any command that requires DNS resolution or HTTP requests

If your piece involves implementation (not just code editing), you almost certainly need to enable network access.

### Configuration

Enable network access via TAKT's `provider_options`:

```yaml
# ~/.takt/config.yaml (applies globally)
provider_options:
  codex:
    network_access: true
```

```yaml
# .takt/config.yaml (applies to this project)
provider_options:
  codex:
    network_access: true
```

```yaml
# In a piece YAML (applies to all movements in this piece)
piece_config:
  provider_options:
    codex:
      network_access: true
```

```yaml
# Per movement (applies to this movement only)
movements:
  - name: implement
    provider_options:
      codex:
        network_access: true
```

Settings are merged with the following priority (highest wins):

```
Movement > Piece > Project (.takt/config.yaml) > Global (~/.takt/config.yaml)
```

### Codex sandbox mode reference

For settings beyond network access (e.g., additional writable directories), configure `~/.codex/config.toml` directly:

```toml
# ~/.codex/config.toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/YOU/.gradle", "/Users/YOU/.m2"]
```

Codex sandbox modes:

| Mode | Filesystem | Network | Use Case |
|------|-----------|---------|----------|
| `read-only` | Read only | Blocked | Code review, analysis |
| `workspace-write` | CWD + `/tmp` writable | Blocked by default | Implementation (default) |
| `danger-full-access` | Unrestricted | Unrestricted | Full autonomy |

## OpenCode CLI

### No native sandbox

OpenCode does **not** have a sandbox. Its permission system is a UX notification mechanism, not a security boundary. As stated in OpenCode's [SECURITY.md](https://github.com/anomalyco/opencode/blob/dev/SECURITY.md):

> "OpenCode does not sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking."

This means that even in `edit` mode, an agent running on OpenCode can potentially access resources outside the working directory via Bash commands. If you need true isolation, run OpenCode inside a Docker container or VM.

### Network access control

OpenCode has no dedicated `network_access` flag. TAKT implements this as an abstraction layer by controlling the `webfetch` and `websearch` tool permissions:

- `network_access: true` — Enables `webfetch` and `websearch` tools
- `network_access: false` — Disables `webfetch` and `websearch` tools
- Not set — Uses the defaults from the permission mode

```yaml
# ~/.takt/config.yaml
provider_options:
  opencode:
    network_access: true
```

Note that this only controls TAKT-managed tools. Bash commands can still make network calls regardless of this setting, since OpenCode has no sandbox.

## Claude Code Sandbox

### The problem

When a movement uses `permission_mode: edit` (mapped to Claude SDK's `acceptEdits`), Bash commands run inside a macOS Seatbelt sandbox. This sandbox blocks:

- Writes outside the working directory (e.g., `~/.gradle`)
- Certain system calls required by JVM initialization
- Network access (by default)

As a result, build tools like Gradle, Maven, or any JVM-based tool fail with `Operation not permitted`.

### Solution: `provider_options.claude.sandbox`

#### Option A: `allow_unsandboxed_commands` (Recommended)

Allow all Bash commands to run outside the sandbox while keeping file edit permissions controlled:

```yaml
provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
```

#### Option B: `excluded_commands`

Exclude only specific commands from the sandbox:

```yaml
provider_options:
  claude:
    sandbox:
      excluded_commands:
        - ./gradlew
        - npm
        - npx
```

### Configuration levels

Same 4-level merge as Codex (Movement > Piece > Project > Global). See the Codex section above for examples at each level.

### Security comparison

| Configuration | File Edits | Network | Bash Commands | Risk |
|--------------|-----------|---------|---------------|------|
| `permission_mode: edit` (default) | Permitted | Blocked | Sandboxed | Low |
| `excluded_commands: [./gradlew]` | Permitted | Blocked | Only listed commands unsandboxed | Low |
| `allow_unsandboxed_commands: true` | Permitted | Allowed | Unsandboxed | Medium |
| `permission_mode: full` | All permitted | Allowed | Unsandboxed | High |

**Key difference**: `allow_unsandboxed_commands` only removes the Bash sandbox — file edits still require Claude Code's permission check (`acceptEdits` mode). `permission_mode: full` bypasses all permission checks entirely.

## Security Considerations for `full` Mode

Setting `permission_mode: full` (or `default_permission_mode: full` in provider profiles) removes all guardrails. The agent can:

- Read and write any file on the system
- Execute any command without confirmation
- Access the network without restriction
- Modify or delete files outside the working directory

### When `full` mode is acceptable

- **Code-only implementation tasks** — If the piece only writes source code within the project directory, the practical risk is low. The agent's actions are constrained by the task instructions and reviewed by subsequent movements.
- **Build tasks that need system access** — Gradle, Maven, npm tasks that write to global caches (`~/.gradle`, `~/.m2`, `~/.npm`).
- **CI/CD pipelines** — Running in an isolated container where the blast radius is already limited.

### When to be cautious with `full` mode

- **Tasks involving external services** — If the agent might call APIs, send emails, or interact with databases, `full` mode gives it unrestricted access to do so.
- **Shared development machines** — Other users' files are accessible.
- **Tasks with user-provided input** — If task instructions come from untrusted sources (e.g., public GitHub Issues), `full` mode allows arbitrary command execution.

### Recommended approach

Use `edit` mode as the default and only escalate specific movements that need it:

```yaml
provider_profiles:
  codex:
    default_permission_mode: edit
    movement_permission_overrides:
      implement: full    # Needs build tools and network
      review: readonly   # Only reads code
```

Combined with `network_access: true` for the provider options:

```yaml
provider_options:
  codex:
    network_access: true
```

This gives `implement` full access for builds while keeping review movements locked down.

## Recommended Configuration

### For Codex users

```yaml
# ~/.takt/config.yaml
provider: codex

provider_options:
  codex:
    network_access: true       # Required for npm install, builds, etc.

provider_profiles:
  codex:
    default_permission_mode: edit  # workspace-write sandbox
```

### For OpenCode users

```yaml
# ~/.takt/config.yaml
provider: opencode

provider_options:
  opencode:
    network_access: true       # Enable web search/fetch tools

provider_profiles:
  opencode:
    default_permission_mode: edit
```

### For multi-provider setups

```yaml
# ~/.takt/config.yaml
provider: claude

provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
  codex:
    network_access: true
  opencode:
    network_access: true

provider_profiles:
  claude:
    default_permission_mode: edit
  codex:
    default_permission_mode: edit
  opencode:
    default_permission_mode: edit

# Route personas to different providers
persona_providers:
  coder:
    provider: codex
  reviewer:
    provider: claude
```

## Configuration Priority Summary

Provider options (`provider_options`) and permission profiles (`provider_profiles`) are resolved from multiple sources. Higher priority wins:

**Provider options** (merged, higher overrides lower):

| Priority | Source | Example |
|----------|--------|---------|
| 1 (highest) | Movement `provider_options` | `movements[].provider_options.codex.network_access` |
| 2 | Piece `piece_config.provider_options` | `piece_config.provider_options.codex.network_access` |
| 3 | Project `.takt/config.yaml` | `provider_options.codex.network_access` |
| 4 (lowest) | Global `~/.takt/config.yaml` | `provider_options.codex.network_access` |

**Permission mode** (first match wins):

| Priority | Source |
|----------|--------|
| 1 (highest) | Project `provider_profiles.<provider>.movement_permission_overrides.<movement>` |
| 2 | Global `provider_profiles.<provider>.movement_permission_overrides.<movement>` |
| 3 | Project `provider_profiles.<provider>.default_permission_mode` |
| 4 | Global `provider_profiles.<provider>.default_permission_mode` |
| 5 (floor) | Movement `required_permission_mode` (minimum; raises resolved mode if lower) |

Default permission mode when nothing is configured: `readonly`.
