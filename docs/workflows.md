# Workflow Guide

This guide explains how to create and customize TAKT workflows.

## Workflow Basics

A workflow is a YAML file that defines a sequence of steps executed by AI agents. Each step specifies:
- Which persona to use
- What instructions to give
- Rules for routing to the next step

## File Locations

- Builtin workflows are embedded in the npm package (`dist/resources/`)
- `~/.takt/workflows/` — User workflows (override builtins with the same name)
- Use `takt eject <workflow>` to copy a builtin to `~/.takt/workflows/` for customization

## Workflow Categories

To organize the workflow selection UI into categories, configure `workflow_categories`.
See the [Configuration Guide](./configuration.md#workflow-categories) for details.

## Authoring Workflow Files

Use `takt workflow init <name>` to create a new custom workflow scaffold in `.takt/workflows/` (or `~/.takt/workflows/` with `--global`).

- `--template minimal`: generates a self-contained scaffold with generic step routing
- `--template faceted`: generates a workflow plus local persona/instruction facet files

After editing the generated files, run `takt workflow doctor <name or path>` to validate references, routing targets, and unreachable steps before executing the workflow.

## Workflow Schema

```yaml
name: my-workflow
description: Optional description
max_steps: 10
initial_step: first-step          # Optional, defaults to the first step

# Section maps (key → file path relative to workflow YAML directory)
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md
policies:
  coding: ../facets/policies/coding.md
  review: ../facets/policies/review.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
instructions:
  plan: ../facets/instructions/plan.md
  implement: ../facets/instructions/implement.md
report_formats:
  plan: ../facets/output-contracts/plan.md

steps:
  - name: step-name
    persona: coder                   # Persona key (references personas map)
    persona_name: coder              # Display name (optional)
    policy: coding                   # Policy key (single or array)
    knowledge: architecture          # Knowledge key (single or array)
    instruction: implement           # Instruction key (references instructions map)
    edit: true                       # Whether the step can edit files
    required_permission_mode: edit   # Minimum permission: readonly, edit, or full
    provider_options:
      claude:
        allowed_tools:               # Optional Claude tool allowlist
          - Read
          - Glob
          - Grep
          - Edit
          - Write
          - Bash
    rules:
      - condition: "Implementation complete"
        next: next-step
      - condition: "Cannot proceed"
        next: ABORT
    instruction: |                   # Inline instructions
      Your instructions here with {variables}
    output_contracts:                # Report file configuration
      report:
        - name: 00-plan.md
          format: plan               # References report_formats map
```

Steps reference section maps by key name (e.g., `persona: coder`), not by file path. Paths in section maps are resolved relative to the workflow YAML file's directory.


## Available Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Workflow-wide turn count (total steps executed) |
| `{max_steps}` | Maximum steps allowed |
| `{step_iteration}` | Per-step iteration count (how many times THIS step has run) |
| `{previous_response}` | Previous step's output (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during workflow (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/runs/20250126-143052-task-summary/reports`) |
| `{report:filename}` | Inline the content of `{report_dir}/filename` |

> **Note**: `{task}`, `{previous_response}`, and `{user_inputs}` are auto-injected into instructions. You only need explicit placeholders if you want to control their position in the template.

## Rules

Rules define how each step routes to the next step. The instruction builder auto-injects status output rules so agents know what tags to output.

```yaml
rules:
  - condition: "Implementation complete"
    next: review
  - condition: "Cannot proceed"
    next: ABORT
    appendix: |
      Explain what is blocking progress.
```

### Rule Condition Types

| Type | Syntax | Description |
|------|--------|-------------|
| Tag-based | `"condition text"` | Agent outputs `[STEP:N]` tag, matched by index |
| AI judge | `ai("condition text")` | AI evaluates the condition against step output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-step results |

### Special `next` Values

- `COMPLETE` — End workflow successfully
- `ABORT` — End workflow with failure

### Rule Field: `appendix`

The optional `appendix` field provides a template for additional AI output when that rule is matched. Useful for structured error reporting or requesting specific information.

## Step Types

TAKT supports five step types. Pick by the structure your step needs.

### Normal Step

A single agent executes the step. This is the default and matches all the earlier examples.

### Parallel Step

Sub-steps execute concurrently, and the parent aggregates sub-step matches via `all()` / `any()`:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        persona: architecture-reviewer
        policy: review
        knowledge: architecture
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-arch
      - name: security-review
        persona: security-reviewer
        policy: review
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction: review-security
    rules:
      - condition: all("approved")
        next: COMPLETE
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: true if ALL sub-steps matched condition X
- `any("X")`: true if ANY sub-steps matched condition X
- Sub-step `rules` define possible outcomes; `next` is optional (parent handles routing)
- Parallel sub-steps do not support `promotion`

### Arpeggio Step (data-driven batch)

Iterate over a data source (CSV, JSON, etc.) and apply the same step template to each row with bounded concurrency:

```yaml
  - name: batch-process
    persona: coder
    arpeggio:
      source: csv
      source_path: ./data/items.csv
      batch_size: 5
      concurrency: 3
      template: ./templates/process.txt
      max_retries: 2
      retry_delay_ms: 1000
      merge:
        strategy: concat
        separator: "\n---\n"
      output_path: ./output/result.txt
    rules:
      - condition: "Processing complete"
        next: COMPLETE
```

Useful for batch-applying the same operation to many inputs (file lists, issue lists, generated test cases, etc.).

### Team Leader Step (dynamic task decomposition)

The agent acts as a leader: it decomposes the task into independent sub-parts at runtime and dispatches each part to a worker agent:

```yaml
  - name: implement
    team_leader:
      max_parts: 3
      timeout_ms: 600000
      part_persona: coder
      part_edit: true
      part_permission_mode: edit
      part_allowed_tools: [Read, Glob, Grep, Edit, Write, Bash]
    instruction: |
      Decompose this task into independent subtasks.
    rules:
      - condition: "All parts completed"
        next: review
```

Useful for breaking one large task into independent units that can run in parallel without you having to know the unit boundaries up-front.

### Workflow Call Step (subworkflow)

A step invokes another workflow by name. The child workflow runs in the same run; its outcome routes back via the parent's `rules`:

```yaml
  - name: peer-review
    workflow_call:
      workflow: peer-review
      params:
        impl_knowledge: cqrs-es
    rules:
      - condition: approved
        next: COMPLETE
      - condition: needs_fix
        next: fix
```

The called workflow can declare `subworkflow.params` so the parent passes values (e.g. `impl_knowledge` or `fix_knowledge`) to customize the child without duplicating step definitions. See [Workflow-level Configuration](#workflow-level-configuration) for `subworkflow` declaration.

## Output Contracts (Report Files)

Steps can generate report files in the report directory:

```yaml
# Single report with format specification (references report_formats map)
output_contracts:
  report:
    - name: 00-plan.md
      format: plan

# Single report with inline format
output_contracts:
  report:
    - name: 00-plan.md
      format: |
        # Plan
        ...

# Multiple report files with labels
output_contracts:
  report:
    - Scope: 01-scope.md
    - Decisions: 02-decisions.md
```

## Step-level Provider Promotion

A step can escalate its `provider`, `model`, or `provider_options` based on per-step execution count or AI judgment. Each entry in `promotion` requires at least one of `at: <count>` (matches from the Nth execution of this step onward) or `condition: ai("...")`, plus one or more override targets:

```yaml
steps:
  - name: review
    persona: reviewer
    promotion:
      - at: 3
        model: opus
      - condition: ai("The reviewer keeps rejecting and progress has stalled")
        provider: claude
        model: opus
      - at: 5
        provider:
          type: codex
          model: gpt-5.5
          network_access: true
```

Entries are evaluated in declaration order; the **last matching entry wins**. Promotion is the **highest-priority source** in provider / model / provider_options resolution (above step-level `provider` / `model`).

Promotion is not supported on parallel sub-steps.

## Step Options

| Option | Default | Description |
|--------|---------|-------------|
| `persona` | - | Persona key (references section map) or file path |
| `policy` | - | Policy key or array of keys |
| `knowledge` | - | Knowledge key or array of keys |
| `instruction` | - | Instruction key (references section map) |
| `edit` | - | Whether the step can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous step's output to `{previous_response}` |
| `provider_options.claude.allowed_tools` | - | Claude tool allowlist for the step or workflow |
| `provider_options.claude.effort` | - | Claude reasoning effort: `low`, `medium`, `high`, `xhigh`, `max` (`xhigh` requires Opus 4.7) |
| `provider_options.opencode.variant` | - | OpenCode model variant, passed through as a provider/model-specific string |
| `provider_options.codex.network_access` | - | Allow Codex sandbox to access the network (see [configuration guide](./configuration.md#network-access-network_access)) |
| `provider_options.claude.sandbox.allow_unsandboxed_commands` | - | Run Claude Bash outside the macOS Seatbelt sandbox (see [configuration guide](./configuration.md#claude-code-sandbox-control-allow_unsandboxed_commands)) |
| `provider` | - | Override provider for this step (`claude`, `claude-sdk`, `codex`, `opencode`, `cursor`, or `copilot`) |
| `model` | - | Override model for this step |
| `promotion` | - | Per-execution provider/model/options escalation (see [Step-level Provider Promotion](#step-level-provider-promotion)) |
| `mcp_servers` | - | Per-step MCP server configuration (stdio / HTTP / SSE) |
| `allow_git_commit` | `false` | Allow `git add` / `commit` / `push` in step instructions. Default prohibits these so each PR represents one task |
| `required_permission_mode` | - | Required minimum permission mode: `readonly`, `edit`, or `full` |
| `output_contracts` | - | Report file configuration (name, format) |
| `quality_gates` | - | Quality criteria for step completion (AI instruction) |

## Workflow-level Configuration

Top-level workflow fields that control overall execution behavior.

### `interactive_mode`

Default interactive mode used when `takt` is invoked without arguments. One of `assistant` (default), `passthrough`, `quiet`, `persona`.

```yaml
interactive_mode: assistant
```

### `workflow_config.provider_options`

Workflow-wide provider options. Merged with step / persona / project / global options. Step-level options take priority for the same leaf.

```yaml
workflow_config:
  provider_options:
    codex:
      network_access: true
    claude:
      sandbox:
        allow_unsandboxed_commands: true
```

### `workflow_config.runtime`

Runtime prepare scripts that run before workflow execution. Builtin presets `node` / `gradle` are always allowed. Custom script paths require `workflow_runtime_prepare.customScripts: true` in config.

```yaml
workflow_config:
  runtime:
    prepare: [node, gradle, ./custom-script.sh]
```

### `loop_monitors`

Detect cyclic patterns between steps (e.g. `review` → `fix` → `review` repeating indefinitely) and let an AI judge whether progress is being made:

```yaml
loop_monitors:
  - cycle: [review, fix]
    threshold: 3
    judge:
      persona: supervisor
      instruction: "Evaluate if the fix loop is making progress..."
      rules:
        - condition: "Progress is being made"
          next: fix
        - condition: "No progress"
          next: ABORT
```

### `rate_limit_fallback`

When a Claude / Codex / OpenCode rate limit is observed during a step, continue the run by re-executing the interrupted step on the next provider in the chain. The new session receives a fallback notice instruction so the AI can rebuild context from existing reports on disk.

```yaml
rate_limit_fallback:
  switch_chain:
    - provider: claude-sdk
      model: opus
    - provider: codex
      model: gpt-5.5
```

Attempts within a single fallback chain are tracked on workflow state and reset on a successful step completion. The same field is also accepted in `~/.takt/config.yaml` and `.takt/config.yaml` for project-wide / user-wide defaults.

### `subworkflow`

Declare a workflow as a subworkflow that accepts parameters from a parent's `workflow_call`. Subworkflows are not selectable from the workflow UI.

```yaml
subworkflow:
  visibility: internal
  params:
    - name: impl_knowledge
      required: true
```

## Examples

### Simple Implementation Workflow

```yaml
name: simple-impl
max_steps: 5

personas:
  coder: ../facets/personas/coder.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      Implement the requested changes.
```

### Workflow with Review

```yaml
name: with-review
max_steps: 10

personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md

steps:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: ABORT
    instruction: |
      Implement the requested changes.

  - name: review
    persona: reviewer
    edit: false
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction: |
      Review the implementation for code quality and best practices.
```

### Passing Data Between Steps

```yaml
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md

steps:
  - name: analyze
    persona: planner
    edit: false
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Analysis complete
        next: implement
    instruction: |
      Analyze this request and create a plan.

  - name: implement
    persona: coder
    edit: true
    pass_previous_response: true
    required_permission_mode: edit
    provider_options:
      claude:
        allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
    instruction: |
      Implement based on this analysis:
      {previous_response}
```

## Best Practices

1. **Keep iterations reasonable** — 10-30 is typical for development workflows
2. **Use `edit: false` for review steps** — Prevent reviewers from modifying code
3. **Use descriptive step names** — Makes logs easier to read
4. **Test workflows incrementally** — Start simple, add complexity
5. **Use `/eject` to customize** — Copy a builtin workflow as a starting point rather than writing from scratch
