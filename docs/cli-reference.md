# CLI Reference

[English](./cli-reference.md) | [日本語](./cli-reference.ja.md) | [简体中文](./cli-reference.zh-CN.md)

This document provides a complete reference for all TAKT CLI commands and options.

## Global Options

| Option | Description |
|--------|-------------|
| `--pipeline` | Enable pipeline (non-interactive) mode -- required for CI/automation |
| `-t, --task <text>` | Task content (alternative to GitHub Issue) |
| `-i, --issue <N>` | GitHub issue number (same as `#N` in interactive mode) |
| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |
| `-b, --branch <name>` | Specify branch name (auto-generated if omitted) |
| `--pr <number>` | PR number to fetch review comments and fix |
| `--auto-pr` | Create PR after execution (pipeline mode only) |
| `--draft` | Create PR as draft (requires `--auto-pr` or `auto_pr` config) |
| `--skip-git` | Skip branch creation, commit, and push (pipeline mode, workflow-only) |
| `--repo <owner/repo>` | Specify repository (for PR creation) |
| `-q, --quiet` | Minimal output mode: suppress AI output (for CI) |
| `--provider <name>` | Override agent provider (claude\|claude-sdk\|claude-headless\|claude-terminal\|codex\|opencode\|deepseek-harness\|cursor\|copilot\|kiro\|pi\|mock) |
| `--auto-strategy <strategy>` | Override the auto-routing strategy (`cost`\|`balanced`\|`performance`). Applied when execution reaches the current workflow or a workflow-call child with effective `auto_routing`; otherwise, TAKT warns and ignores the option. |
| `--model <name>` | Override agent model |
| `--runtime-assignment <name>` | Select a merged runtime `provider.assignments` entry for this invocation; takes precedence over `provider.directories` |
| `-c, --continue` | Continue from the last assistant session for the current project directory and provider |
| `--tui` | The TUI is what a terminal gets anyway: with a TTY on stdin and stdout the task conversation is drawn by Ink whether or not this flag is given, and piped input keeps the plain reader. The flag only makes that requirement explicit — without a TTY it fails with `--tui requires an interactive terminal` instead of falling back. Workflow, mode and post-summary selection stay on the usual selectors; only the conversation is drawn by the TUI. Enter sends, Shift+Enter or Option+Enter inserts a newline, Ctrl+K cuts to the end of the line, Esc interrupts the answer in progress, and anything queued behind it is sent as the next turn. Interrupted user messages are quoted in sending order before the next regular message, whether queued or typed later, until an answer completes. Commands such as /go keep them pending and summarize the original history; ending the conversation sends nothing further. User lines and history retain each original message once. Lines submitted while the assistant is answering are queued and sent when it finishes; ↑ takes the last one back until the queue starts moving. The session stays open after a task runs, until /cancel. A result saved by an earlier run (for example a `takt run` finished in another terminal) is discarded silently when the TUI starts; only the plain reader still prints it once. Workflows started from the TUI session itself are still announced when they finish |

When the terminal is resized, the TUI briefly pauses live drawing and redraws only the
input/status region once resizing settles. Existing terminal scrollback, including shell
output and earlier conversation messages, remains available through the terminal's usual
scrolling controls. Committed messages are not replayed on resize or when returning from
selectors and tasks. User and AI paragraphs use the terminal's native wrapping, so
previously committed paragraphs can widen again; explicit source newlines remain.
History printed by the older hard-wrapping renderer retains its existing breaks.
The draft, queued input, and in-flight requests are retained.
In the task conversation, the caret row is the first row inside the input box;
status, notices and queued input appear below the box. Earlier display rows are folded,
with `↑ N` indicating their count. Up/down still edits those rows, and folding or
resizing does not change the submitted text.

`--workflow` is the canonical option.

The global config directory (default: `~/.takt/`) can be changed with the `TAKT_CONFIG_DIR` environment variable.

`--runtime-assignment` works on interactive startup, direct execution, pipeline, `run`, `watch`,
and other subcommands. It changes only the assignment's defaults/targets; shared sections and
existing provider/model/auto-strategy override priority stay unchanged. A missing name or no active
runtime provider section fails before any agent starts and reports available names (or no definitions).
The selection is not written to configuration or task records and is not restored by requeue/retry/instruct.
Without this option, directory selection works as before.

```sh
takt --runtime-assignment cost "#123"
takt run --runtime-assignment quality
takt --pipeline --runtime-assignment cost "#123"
```

See [named assignments](./configuration.md#named-assignments) for shared cost/quality presets
and personal assignments in `~/.takt/runtime.yaml`.

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

## DeepSeek Harness

`takt install deepseek-harness` installs the required official SDK. It needs access to the npm registry. If the provider still malfunctions after installation, run `takt install deepseek-harness --force`. See the [configuration guide](./configuration.md#deepseek-harness-deepseek-harness) for credentials and `provider: deepseek-harness`.

## Manager (experimental)

In the manager TUI, enter `/go` without arguments to request a summary of the current conversation. A returned summary waits for approval. If a summary is already displayed, `/go` approves and registers it without regenerating it. Insufficient material is reported so you can continue the conversation. See [Managing goals](./goal-management.md) for the TUI commands.

Use `takt daemon stop` to stop the manager background daemon. Opening manager or answering a question or resuming a goal in its TUI starts the daemon again when needed. It exits automatically when its projects have no unfinished goals, pending events, or pending/running tasks.

`takt manager` opens a goal conversation TUI in an interactive terminal. manager is experimental: behavior, settings, and saved data formats may change without notice. It automatically queues and runs tasks, which incurs provider API costs. These notices appear above the input box on every startup and in `takt manager --help`, in the configured language (Japanese or English).

## Web UI execution boundary

Run `takt ui` to start the experimental local Web UI on `http://127.0.0.1:20525`, or pass `--port`. The command warns that the experimental interface may change without notice. If an instance for the same `TAKT_CONFIG_DIR` is already running, the command prints its actual URL and PID without starting another process. Use `takt ui stop` for a graceful stop and `takt ui restart [--port <number>]` to stop and start it again.

The Web UI stores execution records under `TAKT_CONFIG_DIR`. Using the CLI and Web UI to operate on the same project simultaneously is unsupported. Use one interface at a time while a task runs.

Viewer shows execution status, live logs, and reports. Use “Create task” to start a conversation, then `/setup` to configure the worktree, task branch, base branch, automatic pull-request creation, and draft status. An instruction produced by `/go` keeps those settings. The header switches the display language. When automatic PR creation is enabled, a successful workflow is committed, pushed, and published as a PR. Tasks in `failed` or `exceeded` status can be submitted again with the same settings using `Requeue` in the run detail.

Chat shows your conversation history.

The execution map is evidence-based: “observed participant” and “observed boundary” labels come from persisted lifecycle records, while “pool” indicates scheduler classification rather than an observed edge. `PREV` and `NEXT` name the incoming and outgoing ports of a step or boundary. A parallel invocation is drawn as one fork from the boundary's `PREV` port and one join into its `NEXT` port; participants are not connected to each other merely because their events were recorded sequentially.

For credentials in Web UI MCP settings, use an environment-variable reference in `${ENV_VAR}` form. See the [Web UI guide](../web-ui/README.md) for setup and operations.

## Interactive Mode

A mode where you refine task content through conversation with AI before execution. Useful when task requirements are ambiguous or when you want to clarify content while consulting with AI.

The ordinary assistant conversation can also read compact task and run state through read-only MCP tools. Ask about the task by name or summary; the assistant reads detailed logs and reports only for a run you identify. When the requested change is ready, use `/go` for a new task, `/tell` for an additional instruction to a running worktree-clone task, or `/requeue` and `/retry` to return a failed task to the queue.

```bash
# Start interactive mode (no arguments)
takt

# Specify initial message (short word only)
takt hello
```

**Note:** `--task` option skips interactive mode and executes the task directly. Issue references (`#6`, `--issue`) are used as initial input in interactive mode.

In the TUI conversation history, submitted user messages are initially printed with a full-width background band, one blank row above and below the text, and a `❯` marker followed by a space. The band and text colors adapt to the terminal background when the terminal reports it, with a dark-gray and white fallback. Previously painted background padding is not repainted when the terminal is resized. The current, unsubmitted draft remains in the normal input area and does not use this styling. You can scroll through earlier messages while an answer is being generated with your terminal's usual mouse wheel or scroll shortcut.

### Flow

1. Select workflow
2. Select interactive mode (assistant / grill-me / persona)
3. Refine task content through conversation with AI
4. Finalize task instructions with `/go` (you can also add additional instructions like `/go additional instructions`)
5. Execute (run workflow, create PR)

`/go` creates instructions for the latest task topic; earlier topics are included only when you explicitly combine them into the same task.

When an Issue is loaded, each `/go` judges whether the latest task belongs to that current Issue. A related instruction shows `Issue: #N` immediately after the task heading in the preview, before the existing action menu. Execute, Save as Task, and Create Issue use N only when that line matches the current Issue. Unrelated tasks follow the flow without a loaded Issue. Choose Continue editing to correct the binding; no extra confirmation is added. After `/issue` replaces the context, the next instruction is judged again without inheriting earlier bindings.

### Interactive Mode Variants

| Mode | Description |
|------|-------------|
| `assistant` | Default. AI asks clarifying questions before generating task instructions. |
| `grill-me` | Resolves material decision branches one recommended question at a time, then suggests `/go` when the requirements are ready. |
| `persona` | Conversation with the first step's persona (uses its system prompt and tools). |

### Conversation Settings Commands

| Command | Effect |
|---------|--------|
| `/workflow` | Select another workflow. |
| `/interaction` | Select another interactive mode. |
| `/provider` | Select another provider. |
| `/model <value>` | Use a free-form model override for this conversation. |
| `/effort <value>` | Use a free-form reasoning effort override for this conversation. |
| `/tell [instruction]` | Select a running worktree-clone task, review an additional instruction, and send it after confirmation. With no inline instruction, the latest discussion about that task is converted into a standalone additional-instruction body. An interactive terminal is required; no instruction is sent when confirmation is unavailable. |
| `/requeue [guidance]` | In an assistant or grill-me conversation, requeue a failed or exceeded task. Guidance is appended as the final user turn for task and start-position selection. If the AI cannot decide or its selection fails, choose from the available candidates. Review the task details and confirm with Y/n. Without guidance, exceeded tasks keep the saved stopping position. |
| `/retry [guidance]` | In an assistant or grill-me conversation, resolve a failed task from the conversation and prepare a complete revised order for Save task / Continue confirmation. The inline text is guidance, not a task name. |

`/tell` is available in the ordinary CLI/TUI `assistant`, `grill-me`, and `persona` conversations, including after switching between those modes. It still requires a running task backed by a valid TAKT-managed worktree clone when selecting a recipient. The Web UI does not execute the local `/tell` handoff; text such as `/tell review this task` is sent to the assistant as a regular message. Dedicated Retry and Instruct conversations do not expose `/tell`; use their task-action controls instead.

Use `/issue <number>` or `/issue <number> <number> ...` in an ordinary CLI/TUI `assistant`, `grill-me`, or `persona` conversation to fetch Issues from the configured VCS provider and replace the current Source Context. Both bare numbers and `#`-prefixed numbers are accepted. The conversation history and AI session stay active; later messages and `/go` use the replacement context. If fetching any requested Issue fails, the existing context remains active. This command is not available in `takt exec`.

Use `/requeue` and `/retry` in CLI/TUI `assistant` and `grill-me` conversations. `/requeue` confirms and resubmits a failed or exceeded task. `/retry` revises a failed task's instructions before resubmitting it. If the AI cannot select a task or start position for `/requeue`, including a failed selection call, TAKT asks you to choose from the available candidates. Guidance is appended as the final user turn in both queries rather than mechanically matched to a candidate name. `/retry` retains its existing behavior of stopping with a notice when the task or start position is ambiguous. Cancelling selection or confirmation leaves the task unchanged and records the result in the conversation. Both commands return the confirmed task to `pending` without running it immediately. Both require an interactive terminal; without a TTY, neither selection nor task changes occur. To change the restart position for an exceeded task, add guidance to `/requeue`. In the Web UI, use the action on the task instead.

Selections are temporary and are not persisted. Workflow, mode, provider, and model changes create a new AI session on the next ordinary message or `/go`; the prior transcript is included once as reference context. An effort-only change applies to the next call in the current session. Changing provider clears temporary model and effort overrides. If multiple settings commands are run before the next input, only the most recently selected value for each setting is applied. These conversation overrides do not affect workflow execution.

The results of saving, creating an Issue, or executing after /go, and of /tell, /retry, and /requeue, are recorded in the conversation with the same facts as the screen notice. Subsequent messages and /go can refer to the saved task name, Issue number, cancellation, and failure reason. Saving or Issue creation failures return to the same conversation after displaying the reason. Cancelling the save settings also returns to the conversation without reopening the selector. If saving fails after an Issue was created, the notice distinguishes the existing Issue from the unsaved task. Notices for /issue and conversation settings changes are excluded from these operation records.

### Formal Specification Verification

When formal specification mode is enabled for the current interactive session, run `/verify` to verify the current agreement in one shot. TAKT asks the assistant to output the current agreement as Quint and Alloy specifications, runs the verifiers on the extracted code blocks, and sends the results back to the same session for the assistant to interpret. The basic Quint stages run with nothing extra installed; model checking with `quint verify` and the Alloy Analyzer needs Java 17 or later.

See [Formal Specification Verification](./formal-verification.md) for requirements, first-run downloads, how the stages and verification targets are chosen, and how to read the result.

### Execution Example

```
$ takt

Select workflow:
  > default (current)
    Development/
    Research/
    Cancel

Interactive mode - describe your task. When ready, use /go to create the instruction and run it.

> I want to add user authentication feature

[AI confirms and organizes requirements]

> /go

Proposed task instructions:
---
Implement user authentication feature.

Requirements:
- Login with email address and password
- JWT token-based authentication
- Password hashing (bcrypt)
- Login/logout API endpoints
---

Proceed with these task instructions? (Y/n) y

[Workflow execution starts...]
```

## Direct Task Execution

Use the `--task` option to skip interactive mode and execute directly.

```bash
# Specify task content with --task option
takt --task "Fix bug"

# Specify workflow
takt --task "Add authentication" --workflow dual
```

**Note:** Passing a string as an argument (e.g., `takt "Add login feature"`) enters interactive mode with it as the initial message.

## Workflow Maker

`takt make` starts the TTY-only Workflow Maker. Before the conversation, choose New workflow or a project, global, built-in, or repertoire workflow as the base. Existing workflows are reference inputs only; Workflow Maker never edits the selected source.

Use `/workflow` to replace the base during the conversation and `/go` to prepare a complete implementation instruction. The approval screen shows the planned `.takt/make/YYYYMMDD-HHmmss-SSS/` path and offers exactly Execute, Continue editing, and Cancel. No Maker artifact is written until Execute is selected.

An approved run copies the statically reachable dependency closure into an isolated directory containing `workflows/`, `steps/`, `facet-pools/`, and `facets/`, rewrites references to the copies, and runs the built-in `workflow-maker` directly with that directory as its working directory. It does not create a task, worktree, commit, push, or pull request. Dynamic or unresolved dependencies fail before execution. Completed and failed runs remain at their displayed paths, including the doctor report when one was produced.

```bash
takt make
```

## ACP Agent

`takt-acp` starts TAKT as an Agent Client Protocol agent over stdio JSON-RPC.
Launch it from an ACP-compatible client as the agent command:

```bash
takt-acp
```

The ACP session `cwd` must be an absolute path. TAKT uses that directory as both the conversation base and workflow project root. By default, `session/prompt` is an enqueue-first conversation entrypoint: prompts such as "enqueue this task" or "make it a pending task" add a pending task to `.takt/tasks.yaml` with `worktree: true`, and the task can later be executed with `takt run`. Direct workflow execution is kept only for explicit requests such as "run it now" or "execute now"; ambiguous prompts stay in the conversation. The main ACP UX does not depend on `/go`, which follows the session `defaultAction` and is enqueued by default.

If an ACP prompt creates or directly executes a task, TAKT uses the `default` workflow unless the conversation result explicitly provides another workflow.

`session/new` may omit `mcpServers`; omitted or empty `mcpServers: []` is treated as no MCP servers. Stdio MCP servers are passed to workflow execution, but TAKT fails fast before the run when the effective provider for a step does not support MCP servers. Non-stdio MCP transports, duplicate MCP server names, and duplicate trimmed MCP env names are rejected during session creation.

TAKT currently supports `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/update` notifications. `additionalDirectories` is not advertised and non-empty `additionalDirectories` requests are rejected.

## MCP Server

`takt-mcp` starts TAKT as a stdio Model Context Protocol server. Register it in an MCP client when you want to enqueue tasks, inspect task/run state, or send an additional instruction to a running worktree-clone task without shelling out to TAKT commands.

```bash
takt-mcp
```

For Codex, add a stdio MCP server to `~/.codex/config.toml`, or to project-scoped `.codex/config.toml` for trusted projects:

```toml
[mcp_servers.takt]
command = "takt-mcp"
```

You can also add it with the Codex MCP CLI:

```bash
codex mcp add takt -- takt-mcp
```

The server exposes these tools:

| Tool | Description |
|------|-------------|
| `takt_enqueue_task` | Save a pending task to `.takt/tasks.yaml`, optionally linking or creating an issue. |
| `takt_list_tasks` | Read compact task and run summaries without loading log or report contents. |
| `takt_get_run` | Read one run's current step, phase, logs, reports, and live-intervention delivery state. |
| `takt_tell_run` | Recheck and send an additional instruction to one running worktree-clone task. |
| `takt_cleanup_tasks` | Preview filtered tasks and delete them only with `confirm: true` (`all` only). |

`takt_cleanup_tasks` previews filtered tasks before deletion. It requires an absolute `cwd` and a `reason`. Optional inputs are `statuses` (one or more of `pending`, `completed`, `failed`, `exceeded`, and `pr_failed`; `running` is not allowed), `goalId`, `branch`, and `confirm` (default `false`). At least one of `statuses`, `goalId`, or `branch` is required.

Omitting `confirm` or setting it to `false` returns only the matching list without deleting anything. Only `confirm: true` deletes tasks, with the same deletion scope as `takt list`. This tool is available only in the `all` tool set, not in `read-only` or `manager`; `manager` has the separate `takt_remove_goal_task` tool.

`takt_stop_goal_task` is available in the `manager` and `all` tool sets. Pass an absolute `cwd`. From one task item returned by `takt_list_tasks`, pass its `name` value as `taskName` and use its `goalId` and `executionId`. The owner PID must be alive. When an owner start time is saved, the current start time must be available and match it. Without a saved start time, matching goalId, taskName and executionId, running status, and a live owner PID are sufficient to accept the request. Mismatched identities, non-running tasks, and ended owners are rejected with a reason and no stop request is saved. The tool only saves the request; the task stays `running` while its worker polls every 500 ms and aborts itself. After execution and cleanup finish, the worker saves `failed` with a task stop reason, distinct from a goal abort. Other tasks and the goal remain active. Repeated requests return the saved request only if the same execution is still `running` and its owner can be verified when the request is evaluated; retries use a new execution ID.

Before processing each project's events, the daemon recovers interrupted tasks to `failed` and creates goal-task completion events, even when no pending tasks exist. Recovery requires an absent or dead owner PID, or a known mismatch between the saved and current owner start times. A live PID with unavailable saved or current owner identity is left running.

Every tool `cwd` is resolved with `realpath` and must stay inside the MCP server's allowed project root. By default that root is the directory where `takt-mcp` was started.

Use `--tool-set read-only` when registering a server for a client that should only inspect task state. This exposes `takt_list_tasks` and `takt_get_run`; it does not expose `takt_enqueue_task` or `takt_tell_run`. The assistant conversation uses this read-only tool set automatically. Providers without MCP support continue the conversation and report that task-state lookup is unavailable.

### `takt_enqueue_task`

Required input:

| Field | Type | Description |
|-------|------|-------------|
| `cwd` | absolute path string | Project root where `.takt/tasks.yaml` is written. |
| `task` | string | Task instruction body. |
| `workflow` | string | Workflow name or path. MCP callers must ask which workflow to use before enqueueing. |
| `autoPr` | boolean | Save the task with auto-PR enabled. MCP callers must ask before enqueueing. |

Optional input:

| Field | Type | Description |
|-------|------|-------------|
| `worktree` | boolean | `true` creates an automatic isolated worktree. Defaults to `true`. MCP input does not accept custom worktree paths. |
| `draftPr` | boolean | Save explicit `true` / `false` as `draft_pr`, overriding project and global settings at execution time. Omission saves no value and preserves configuration inheritance. |
| `issue.number` | positive safe integer | Link an existing issue without calling an issue provider. |
| `issue.create` | `true` | Create an issue through the configured issue provider before enqueueing. |
| `issue.title` | string | Optional non-empty title for a newly created issue. Limited to 255 characters. |
| `issue.labels` | string array | Optional non-empty labels for a newly created issue. |
| `taskContext.branch` | string | Local branch name to save with the task. |
| `taskContext.baseBranch` | string | Base branch name to save with the task. |
| `taskContext.prNumber` | positive safe integer | Pull request number to save with the task. Values greater than `Number.MAX_SAFE_INTEGER` are rejected. |

Input limits: `task` is limited to 128 KiB, `workflow` to 128 characters, an issue title to 255 characters, each issue label to 100 characters, and at most 20 labels.

A successful enqueue returns saved `worktree`, `autoPr`, and `draftPr` in addition to the existing `taskName`, `tasksFile`, `workflow`, and issue-related fields. Omitted `worktree` returns the saved value `true`; omitted `draftPr` returns `null`, not the effective configuration value. These rules apply to ordinary enqueue, existing issue linkage, and new issue creation. The combination `autoPr: false` and `draftPr: true` is saved as given; automatic PR creation still follows `autoPr`.

The `issue` object must be exactly one of `{ "number": 123 }` or `{ "create": true, "title"?: "...", "labels"?: ["..."] }`; mixed keys, empty titles or labels, and unknown keys are rejected. A successful issue-backed enqueue returns `issueNumber`. If issue creation succeeds but task saving fails or is cancelled after the issue number is resolved, the issue remains open and the MCP error result includes `issueCreated`, `issueNumber`, optional `issueUrl`, `taskEnqueued`, `stage`, and a sanitized `error`. Retry with `{ "issue": { "number": issueNumber } }` to avoid creating another issue. If `stage` is `issue_number_parsing`, `issueNumber` is unavailable; use the optional `issueUrl` to identify the created issue and obtain its number before retrying.

MCP can enqueue tasks, inspect task/run state, and send additional instructions to running clone tasks. Use `takt run` to execute pending tasks and `takt watch` to monitor and execute them continuously.

### `takt_list_tasks`, `takt_get_run`, and `takt_tell_run`

All three tools require the absolute project `cwd` and are limited to the project root allowed by the server. `takt_list_tasks` returns names, summaries, statuses, workflows, run slugs, and available current steps; it does not return log or report bodies. `takt_get_run` takes a `runSlug` from the list and returns details for that run, including step logs, reports, and live-intervention delivery state. `takt_tell_run` takes a non-empty `content`, verifies that the selected slug still identifies a running worktree-clone task immediately before writing, and returns a rejection reason without writing when the run is finished, missing, mismatched, or not a clone.

`takt_list_tasks` returns all tasks even when an individual worktree validation or run metadata read fails. Only the affected entry gains a sanitized `error` string alongside its available basic information; other entries retain their previous contents. Run information is never read from a worktree that failed validation. An unreadable queue or a `cwd` outside the allowed root remains a whole-tool error with no task array.

After delivery succeeds, `takt_tell_run` and CLI `/tell` append instructions to the task's source `order.md` and refresh the active run's `context/task/order.md`. When persistence succeeds, each addition retains its instruction ID and receipt time so later agents and resumed runs can read it. If persistence fails, a warning is written to standard error; the accepted instruction remains delivered and tell still succeeds.

## Instant Exec Mode

`takt exec` starts TAKT's interactive task-entry mode without writing workflow YAML by hand. The Assistant agent clarifies the request, `/go` turns the conversation into a generated workflow, Worker agent(s) implement the task, Review agent(s) review the result, the Replanning agent asks the user for direction when needed, and loop detection prevents repeated unproductive cycles.

```bash
takt exec          # use previous config, or default on first run
takt exec backend  # start from a named preset
takt exec --list   # list available exec presets
```

Preset lookup order is project `.takt/exec/presets/`, then global `$TAKT_CONFIG_DIR/exec/presets/` (or `~/.takt/exec/presets/` when unset), then builtin `builtins/exec/presets/`. Builtin/default presets define agent roles, facets, and loop thresholds only. Provider and model are resolved from normal TAKT configuration when exec mode starts, and the same resolved values are used for the Assistant dialogue and `/setup` display. The generated workflow uses capabilities for tool/skill needs; provider/model/options remain in `runtime.yaml` (or retained legacy config). `effort` is emitted only when it is explicitly configured. Each Codex repository or user Skill scope is inherited when that scope is omitted, and the resolved capability is emitted in the generated workflow. Changes made in `/setup` are saved to `$TAKT_CONFIG_DIR/exec.yaml` (or `~/.takt/exec.yaml` when unset) for the next exec session.

Inside exec mode:

| Command | Description |
|---------|-------------|
| `/setup` | Edit agents, replan facets, loop detection thresholds, and project/global presets |
| `/go` | Summarize the latest task topic into executable task instructions and run the generated workflow |
| `/go <note>` | Run with an additional note appended to the conversation summary |
| `/paste-image` | While editing the current input line, replace the line with a clipboard image placeholder |
| `/cancel` | Exit without executing |

`/setup` can save/delete project or global presets. Instruction, knowledge, and policy fields reference normal facets; new facets are saved under `.takt/facets/{instructions,knowledge,policies}/` or `$TAKT_CONFIG_DIR/facets/{instructions,knowledge,policies}/` (or `~/.takt/facets/{instructions,knowledge,policies}/` when unset).

On `/go`, TAKT writes `.takt/exec/workflow.yaml` and executes it through the existing workflow engine. `/go` with no prior conversation and no inline task text is rejected before creating the workflow. The review result reports are read from the completed run and injected back into the exec assistant session for the final summary.

Image attachments are available while editing exec input. Use `/paste-image` or `Ctrl+V` to attach a clipboard image on macOS, or paste an OSC 1337 inline image from a compatible terminal. TAKT inserts a `[Image #N]` placeholder. The image is sent with an Assistant request only when the current message or `/go <note>` references that placeholder; placeholders that were not attached in the session are treated as normal text. When `/go` runs, referenced stored images are copied into the generated task spec and listed in its attachment section. Supported formats are PNG, JPEG, GIF, and WebP; inline and clipboard images are limited to 10 MiB. TAKT rejects unsupported image data, mismatched inline-image filename types, oversized images, and stored attachments whose temp path is missing, a symlink, or not a regular file. Providers without native image input receive local path references in the prompt.

Generated exec workflows use `session_key` to keep Worker agent, Review agent, and Replanning agent sessions separate even when they share a persona. Loop detection judges always use fresh sessions. In user-authored workflows, `session_key` is supported only on normal agent steps and parallel sub-steps; it is not supported on system steps, workflow_call steps, loop-monitor judges, or parallel parent steps. The effective session key is suffixed with the resolved provider.

## GitHub Issue Tasks

You can execute GitHub Issues directly as tasks. Issue title, body, labels, and comments are automatically incorporated as task content.

```bash
# Execute by specifying issue number
takt '#6'
takt --issue 6

# Issue + workflow specification
takt '#6' --workflow dual
```

**Requirements:** [GitHub CLI](https://cli.github.com/) (`gh`) must be installed and authenticated.

## Task Management Commands

Batch processing using `.takt/tasks.yaml` with task directories under `.takt/tasks/{slug}/`. Useful for accumulating multiple tasks and executing them together later.

### takt add

Refine task requirements through AI conversation, then add a task to `.takt/tasks.yaml`.

```bash
# Refine task requirements through AI conversation, then add task
takt add

# Add task from GitHub Issue (issue number reflected in branch name)
takt add '#28'
takt add --issue 28

# Specify the workflow for the queued task
takt add -w default

# Create a task from PR review comments
takt add --pr 123
```

`-w, --workflow <name or path>` sets the workflow saved with the task, and `--pr <number>` creates a task from the PR's review comments.

Markdown images and HTML `<img src>` references in GitHub PR and Issue bodies and comments become task attachments automatically. A PR whose description contains a GitHub attachment image can be registered even without review comments. Successful references keep their original syntax and receive `[Image #N]` immediately afterward, with paths listed in the `## 添付画像` section of `order.md`.

```bash
takt add --pr 123 -w default
takt add --issue 28 -w default
takt --pipeline --pr 123 -w default
takt --pipeline --issue 28 -w default
```

Only GitHub attachment URLs are downloaded. PNG, JPEG, GIF, and WebP require matching Content-Type and magic bytes, with a 10 MiB limit per image. Retrieval, validation, or temporary saving failures warn and skip the affected image while registration and execution continue. This guarantee does not cover failures when copying images into the task spec. Authenticated `gh` credentials are preferred, but token authentication cannot access private attachments in some environments; successful retrieval is not guaranteed. See [Task Management](./task-management.md#automatic-github-pr-and-issue-image-attachments) for saved and execution-time paths.

### takt run

Execute all pending tasks from `.takt/tasks.yaml`.

```bash
# Execute all pending tasks in .takt/tasks.yaml
takt run

# Ignore workflow max_steps and continue until another stop condition occurs
takt run --ignore-exceed
```

Without `--ignore-exceed`, a task that reaches workflow `max_steps` stops with `exceeded` status and persists retry metadata in `.takt/tasks.yaml`. With `--ignore-exceed`, `takt run` ignores only that iteration limit, continues execution, and does not write exceeded retry metadata.

### takt watch

Monitor `.takt/tasks.yaml` and auto-execute tasks as a resident process.

```bash
# Monitor .takt/tasks.yaml and auto-execute tasks (resident process)
takt watch

# Ignore workflow max_steps and continue running tasks instead of marking them exceeded
takt watch --ignore-exceed
```

`takt watch --ignore-exceed` has the same semantics as `takt run --ignore-exceed`: it ignores the workflow `max_steps` iteration limit and does not write `exceeded` retry metadata to `.takt/tasks.yaml`.

### takt caccia

Wait for CodeRabbit and handle its unresolved review threads on an existing GitHub pull request. Each iteration runs the configured Caccia workflow in a temporary clone, records a decision report under `.takt/runs/`, pushes fixes, resolves the reviewed CodeRabbit threads, and waits for a review of the pushed commit. Human-started review threads are left untouched. If a CodeRabbit rate-limit notice provides a retry time before the original wait deadline, Caccia posts one `@coderabbitai review` request after that time is reached; it does not post review replies.

```bash
takt caccia 123
```

During execution, Caccia shows review waiting and continued polling, unresolved thread counts, temporary clone creation, pushed commits, resolved threads, the iteration number and limit, and the return to review waiting after each iteration. Workflow headers, steps, streams, and status use the same display as a normal `takt run`.

The PR number is required. Exit code `0` means no unresolved CodeRabbit threads remain after review. A non-zero code indicates that the repository is not using GitHub, CodeRabbit did not post before the wait limit, the iteration limit was reached, or execution failed. The iteration-limit message includes the number of remaining threads. This command requires an authenticated GitHub CLI (`gh`).

`wait_timeout_ms` bounds the initial CodeRabbit review wait and each pushed-commit review wait, including a retry request. If a rate-limit notice gives a retry time before the deadline, Caccia requests one review when that time arrives; a retry time at or beyond the deadline skips Caccia immediately. A review still incomplete at the deadline after a rate-limit notice also skips Caccia. Without a rate-limit notice, an initial timeout skips Caccia and a pushed-commit timeout is an error. This command exits non-zero on a skip or error.

### takt list

List task branches and perform actions (merge, delete, merge from root, etc.).

```bash
# List task branches (merge/delete)
takt list

# Non-interactive mode (for CI/scripts)
takt list --non-interactive
takt list --non-interactive --action diff --branch takt/my-branch
takt list --non-interactive --action delete --branch takt/my-branch --yes
takt list --non-interactive --format json
```

`--action` accepts `diff`, `sync`, `try`, `merge`, or `delete`. Actions other than `delete` require `--branch` in non-interactive mode. A failed `sync` exits with code `1`.

`takt list --non-interactive --action delete` accepts `--status <status...>` to select one or more of `pending`, `completed`, `failed`, `exceeded`, and `pr_failed`. `running` is not allowed because running tasks cannot be deleted. `--goal <goalId>` selects tasks belonging to that goal. `--branch <branch>` is also available; when used alone, it targets only `completed` tasks.

At least one of `--status`, `--goal`, or `--branch` is required. Without a filter, the command exits with an error without deleting anything. Without `--yes`, it lists the matching task names, statuses, branches, and goals, then exits successfully without deleting anything. Only `--yes` performs deletion. Use `--format json` to return the preview as JSON; JSON output includes `goal_id`.

Deletion removes the task's working clone, worktree session files, clone metadata, branch, and record in `.takt/tasks.yaml`, matching deletion from the interactive list.

```bash
# Preview matching tasks, then delete them after checking the list
takt list --non-interactive --action delete --status failed pr_failed
takt list --non-interactive --action delete --status failed pr_failed --yes

# Preview as JSON
takt list --non-interactive --action delete --status failed pr_failed --format json
```

In interactive mode, **Merge from root** merges the root repository HEAD into the worktree branch with AI-assisted conflict resolution.

#### Consult a running task

Selecting a task in `takt list` opens its status-specific action menu. Existing actions such as Instruct and Requeue remain available for their respective task states. For a running task with a worktree clone, select **Interactive** to open the ordinary assistant conversation with that task as the initial `/tell` target. The conversation can inspect other tasks, discuss a new task, and use `/go` to execute or save it. `/tell` displays the task name, workflow, current step, and instruction, then writes only to the task selected at confirmation; `/cancel` closes the conversation or cancels the pending action. `/tell` requires an interactive terminal and sends nothing when confirmation cannot be obtained. **Mark as failed** remains available in the action menu.

Only running tasks backed by a valid TAKT-managed worktree clone are `/tell` candidates. The target is rechecked after confirmation, so a task that finishes while the selector is open receives no instruction.

### Task Directory Workflow (Create / Run / Verify)

1. Run `takt add` and confirm a pending record is created in `.takt/tasks.yaml`.
2. Open the generated `.takt/tasks/{slug}/order.md` and add detailed specifications/references as needed.
3. Run `takt run` (or `takt watch`) to execute pending tasks from `tasks.yaml`.
4. Verify outputs in `.takt/runs/{slug}/reports/` using the same slug as `task_dir`.

## Pipeline Mode

Specifying `--pipeline` enables non-interactive pipeline mode. Automatically creates branch, runs the workflow, commits and pushes. Suitable for CI/CD automation.

```bash
# Execute task in pipeline mode
takt --pipeline --task "Fix bug"

# Pipeline execution + auto-create PR
takt --pipeline --task "Fix bug" --auto-pr

# Link issue information
takt --pipeline --issue 99 --auto-pr

# Specify workflow and branch
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug

# Specify repository (for PR creation)
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo

# Workflow execution only (skip branch creation, commit, push)
takt --pipeline --task "Fix bug" --skip-git

# Minimal output mode (for CI)
takt --pipeline --task "Fix bug" --quiet
```

In pipeline mode, PRs are not created unless `--auto-pr` is specified.

**GitHub Integration:** When using TAKT in GitHub Actions, see [takt-action](https://github.com/nrslib/takt-action). You can automate PR reviews and task execution.

## Utility Commands

### Interactive workflow selection

Run `takt` without a task argument to choose a workflow interactively.

```bash
takt
```

### takt eject

Copy builtin workflows/personas to your local directory for customization.

```bash
# Copy builtin workflows/personas to project .takt/ for customization
takt eject

# Copy to ~/.takt/ (global) instead
takt eject --global

# Eject a specific facet for customization
takt eject persona coder
takt eject instruction plan --global
```

Facet types for `eject` are singular: `persona`, `policy`, `knowledge`, `instruction`, `output-contract` (`takt catalog` uses the plural forms).

Builtin and custom workflow lookup uses `workflows/`.

### takt workflow

Initialize and validate custom workflow definitions.

```bash
# Create a minimal workflow scaffold in project .takt/workflows/
takt workflow init sample-flow

# Create a faceted scaffold in ~/.takt/workflows/
takt workflow init review-flow --template faceted --global

# Validate workflows by name or path
takt workflow doctor sample-flow
takt workflow doctor .takt/workflows/sample-flow.yaml

# Inspect a workflow's configuration and resolution sources
takt workflow inspect sample-flow
takt workflow inspect .takt/workflows/sample-flow.yaml
```

`takt workflow inspect` reports the workflow's configuration and where each resolved value comes from, using the same resolution a run would use — including `--auto-strategy`.

### takt clear

Clear agent conversation sessions (reset state).

```bash
takt clear
```

### takt export-cc

Deploy builtin workflows/personas as a Claude Code Skill.

```bash
takt export-cc
```

### takt export-codex

Deploy TAKT skill files as a Codex Skill (`~/.agents/skills/takt/`).
This command deploys `SKILL.md`, `references/`, `agents/`, `workflows/`, and `facets/`.

```bash
takt export-codex
```

### takt catalog

List available facets across layers.

```bash
takt catalog
takt catalog personas
```

Facet type arguments for `catalog` are plural: `personas`, `policies`, `knowledge`, `instructions`, `output-contracts` (`takt eject` uses the singular forms).

### takt prompt

Preview assembled prompts for each step and phase.

```bash
takt prompt
takt prompt default
```

### takt reset

Reset settings to defaults.

```bash
# Reset global config to builtin template (with backup)
takt reset config

# Reset workflow categories to builtin defaults
takt reset categories
```

### takt metrics

Show analytics metrics.

```bash
# Show review quality metrics (default: last 30 days)
takt metrics review

# Specify time window
takt metrics review --since 7d
```

### takt repertoire

Manage repertoire packages (external TAKT packages from GitHub).

```bash
# Install a package from GitHub
takt repertoire add github:{owner}/{repo}@{ref}

# Install from default branch
takt repertoire add github:{owner}/{repo}

# List installed packages
takt repertoire list

# Remove a package
takt repertoire remove @{owner}/{repo}
```

Installed packages are stored in `~/.takt/repertoire/` and their workflows/facets become available in workflow selection and facet resolution.

When the same workflow name exists in multiple locations, TAKT resolves in this order: `.takt/workflows/` → `~/.takt/workflows/` → builtins. This name resolution covers only the project, user, and builtin layers; repertoire workflows are referenced explicitly as `@{owner}/{repo}/{workflow-name}`.

### takt telemetry

Manage local routing event recording used when effective `auto_routing` is configured. Decisions are written locally to `.takt/events/` as NDJSON; TAKT does not upload them.

```bash
# Show local routing event recording status
takt telemetry status

# Enable local routing event recording
takt telemetry enable

# Disable local routing event recording
takt telemetry disable
```

### takt resume

Show an interactive menu (Requeue / Retry / Instruct / View reports / Cancel) for the most recent aborted or failed direct (one-shot) run in the current project directory; worktree/clone runs are not eligible, and a resumed execution writes its reports to a new run directory.

```bash
takt resume
```

### takt purge

Purge old analytics event files.

```bash
# Purge files older than 30 days (default)
takt purge

# Specify retention period
takt purge --retention-days 14
```

### takt merge

Run a workflow for a pull request. With an explicit number, selection conditions are ignored. Without a number, TAKT collects every open PR number in creation order before reading each PR's details and applying the selection conditions. A PR closed before its details are read is skipped. If the number listing fails, no PR workflow starts.

```bash
takt merge 123
takt merge 123 --workflow merge-review-fix
takt merge 123 --workflow merge-review
takt merge --author alice --label ready --include-forks --concurrency 4
takt merge "everything except prompt changes"
```

The single positional argument is a PR number when it contains only decimal digits; otherwise it is AI selection text. A number bypasses selection conditions and AI selection. With text, TAKT first applies the existing CLI filters or `merge.where` settings and draft/fork exclusions, then judges each remaining candidate using its title, body, labels, head/base branch names, and complete list of changed file paths. Diff contents and review comments are not selection material. Text alone preserves configured filters.

After every candidate has a valid structured decision, TAKT displays selected PR numbers with reasons and excluded PR numbers, then starts only selected PR workflows without confirmation. Missing or invalid decisions, provider errors, or failure to obtain complete selection material stop the command with a nonzero exit code before any PR workflow starts. No candidates or no selected PRs means zero processed, zero merged, and exit code 0. The processed and actual merged counts retain their existing meaning.

By default, draft PRs and forks are excluded. Use `--include-draft` and `--include-forks` to include them. Any CLI selection condition replaces all configured selection conditions. Bulk runs execute two PR workflows at a time by default; `merge.concurrency` changes this limit and `--concurrency` overrides it for one invocation. An explicit PR number processes only that PR. A failure for one PR does not stop the others. The merge builtins execute Caccia explicitly: `merge-review` runs `review → caccia → wait_ci → evaluation comment`, while `merge-review-fix` and `merge-review-fix-simple` run `review/fix → commit_and_push → caccia → wait_ci → merge_pr`. `success` and `skipped` continue to CI on the returned head. `limit` comments with the unresolved thread count and ends COMPLETE without merging. An effect error comments with `error` and ends ABORT. Push, task post-processing, and Pipeline no longer start Caccia implicitly. With `merge.auto_start: true`, PR publication starts the merge workflow, whose explicit effect runs Caccia. The command exits with code 1 if any processed PR remains unmerged.

`merge-review-fix` and `merge-review-fix-simple` investigate every completed CI failure using failed checks, run/attempt/job references, log contents, the cumulative PR diff and related code. Repository defects (including flaky tests and failures also present on main) receive a root fix and read-only review, followed by push → Caccia → CI, for at most two rounds. Only an evidenced external cause permits one CI rerun, independently of the fix budget, including after both fix rounds. The workflow waits for the new attempt on the same HEAD and rechecks all checks and existing merge conditions. Missing evidence, a defect after both fix rounds, a rejected fix or a failed rerun stops recovery with a PR comment containing the counts, last failed checks and references, and investigation summary, then ABORT. Investigation and fix reports remain in the run. Initial success and CI timeout behavior are unchanged; `merge-review` remains comment-only. GitHub Actions log/rerun permission failures and unsupported providers are reported explicitly.

Workflow selection uses the CLI override, then `merge.workflow`, then `merge-review-fix-simple`. The default gathers context, runs one read-only reviewer with dynamic facets, then adjudicates findings and handles fixes, verification, and follow-up review in separate steps. Like `merge-review-fix`, it synchronizes, resolves conflicts when needed, pushes changes, runs the explicit Caccia effect and waits for CI on its returned head, blocks a CHANGES_REQUESTED review, and merges. Use `--workflow merge-review-fix` for parallel review.

GitLab supports explicit MR numbers and bulk selection. Caccia returns `skipped` with `github_unavailable`, then the workflow waits for CI on the returned head. Merge methods and head constraints remain unsupported, so merge operations using either fail. Completing the CI wait alone does not count as a successful merge.

Each PR merge is recorded as a task in `takt list`. Its isolated clone uses the same `worktree_dir` setting as ordinary tasks: by default `../takt-worktrees`, with `.takt/worktrees` as the existing fallback when the parent directory is not writable. If the workflow fails or stops at a conflict, the clone and Git merge state remain available for inspection. Running `takt merge` again creates a new task and isolated clone while preserving the failed task and clone. Use **Requeue** in `takt list` to resume the existing task or **Retry** to revise its instruction and resume; the saved PR identity and fork checks are verified again. A running or pending merge task for the same PR blocks both a new merge and resumption of a failed task. The clone is removed after the PR is confirmed merged. AI conflict resolution may update related source files, tests, and lockfiles; TAKT stages those changes while preserving preexisting unstaged and untracked user edits.
