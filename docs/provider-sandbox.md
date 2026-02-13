# Provider Sandbox Configuration

TAKT supports configuring sandbox settings for AI agent providers. This document covers how sandbox isolation works across providers, how to configure it, and the security trade-offs.

## Overview

| Provider | Sandbox Mechanism | Build Tool Issues | TAKT Configuration |
|----------|------------------|-------------------|-------------------|
| **Claude Code** | macOS Seatbelt / Linux bubblewrap | Gradle/JVM blocked in `edit` mode | `provider_options.claude.sandbox` |
| **Codex CLI** | macOS Seatbelt / Linux Landlock+seccomp | npm/maven/pytest failures (widespread) | `provider_options.codex.network_access` |
| **OpenCode CLI** | None (no native sandbox) | No constraints (no security either) | N/A |

## Claude Code Sandbox

### The Problem

When a movement uses `permission_mode: edit` (mapped to Claude SDK's `acceptEdits`), Bash commands run inside a macOS Seatbelt sandbox. This sandbox blocks:

- Writes outside the working directory (e.g., `~/.gradle`)
- Certain system calls required by JVM initialization
- Network access (by default)

As a result, build tools like Gradle, Maven, or any JVM-based tool fail with `Operation not permitted`.

### Solution: `provider_options.claude.sandbox`

TAKT exposes Claude SDK's `SandboxSettings` through `provider_options.claude.sandbox` at four configuration levels.

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

### Configuration Levels

Settings are merged with the following priority (highest wins):

```
Movement > Piece > Project Local > Global
```

#### Global (`~/.takt/config.yaml`)

Applies to all projects and all pieces:

```yaml
# ~/.takt/config.yaml
provider_options:
  claude:
    sandbox:
      allow_unsandboxed_commands: true
```

#### Project Local (`.takt/config.yaml`)

Applies to this project only:

```yaml
# .takt/config.yaml
provider_options:
  claude:
    sandbox:
      excluded_commands:
        - ./gradlew
```

#### Piece (`piece_config` section)

Applies to all movements in this piece:

```yaml
# pieces/my-piece.yaml
piece_config:
  provider_options:
    claude:
      sandbox:
        allow_unsandboxed_commands: true
```

#### Movement (per step)

Applies to a specific movement only:

```yaml
movements:
  - name: implement
    permission_mode: edit
    provider_options:
      claude:
        sandbox:
          allow_unsandboxed_commands: true
  - name: review
    permission_mode: readonly
    # No sandbox config needed — readonly doesn't sandbox Bash
```

### Security Risk Comparison

| Configuration | File Edits | Network | Bash Commands | CWD-external Writes | Risk Level |
|--------------|-----------|---------|---------------|---------------------|------------|
| `permission_mode: edit` (default) | Permitted | Blocked | Sandboxed | Blocked | Low |
| `excluded_commands: [./gradlew]` | Permitted | Blocked | Only `./gradlew` unsandboxed | Only via `./gradlew` | Low |
| `allow_unsandboxed_commands: true` | Permitted | Allowed | Unsandboxed | Allowed via Bash | **Medium** |
| `permission_mode: full` | All permitted | Allowed | Unsandboxed | All permitted | **High** |

**Key difference between `allow_unsandboxed_commands` and `permission_mode: full`:**
- `allow_unsandboxed_commands`: File edits still require Claude Code's permission check (`acceptEdits` mode). Only Bash is unsandboxed.
- `permission_mode: full`: All permission checks are bypassed (`bypassPermissions` mode). No guardrails at all.

### Practical Risk Assessment

The "Medium" risk of `allow_unsandboxed_commands` is manageable in practice because:

- TAKT runs locally on the developer's machine (not a public-facing service)
- Input comes from task instructions written by the developer
- Agent behavior is reviewed by the supervisor movement
- File edit operations still go through Claude Code's permission system

## Codex CLI Sandbox

Codex CLI uses macOS Seatbelt (same as Claude Code) but has **more severe compatibility issues** with build tools. Community reports show npm, Maven, pytest, and other tools frequently failing with `Operation not permitted` — even when the same commands work in Claude Code.

Codex sandbox is configured via `~/.codex/config.toml` (not through TAKT):

```toml
# ~/.codex/config.toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/YOU/.gradle"]
```

TAKT provides `provider_options.codex.network_access` to control network access via the Codex SDK:

```yaml
provider_options:
  codex:
    network_access: true
```

For other sandbox settings (writable_roots, sandbox_mode), configure directly in `~/.codex/config.toml`.

## OpenCode CLI Sandbox

OpenCode CLI does not have a native sandbox mechanism. All commands run without filesystem or network restrictions. For isolation, the community recommends Docker containers (e.g., [opencode-sandbox](https://github.com/fabianlema/opencode-sandbox)).

No TAKT-side sandbox configuration is needed or available for OpenCode.
