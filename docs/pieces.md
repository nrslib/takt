# Piece Guide

This guide explains how to create and customize TAKT pieces.

## Piece Basics

A piece is a YAML file that defines a sequence of steps executed by AI agents. Each step specifies:
- Which agent to use
- What instructions to give
- Rules for routing to the next step

## File Locations

- Builtin pieces are embedded in the npm package (`dist/resources/`)
- `~/.takt/pieces/` — User pieces (override builtins with the same name)
- Use `takt eject <piece>` to copy a builtin to `~/.takt/pieces/` for customization

## Piece Categories

ピースの選択 UI をカテゴリ分けしたい場合は、`piece_categories` を設定します。  
詳細は `docs/piece-categories.md` を参照してください。

## Piece Schema

```yaml
name: my-piece
description: Optional description
max_iterations: 10
initial_step: first-step  # Optional, defaults to first step

steps:
  - name: step-name
    agent: ../agents/default/coder.md  # Path to agent prompt file
    agent_name: coder                  # Display name (optional)
    edit: true                         # Whether the step can edit files
    allowed_tools:                     # Optional tool allowlist
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
    instruction_template: |
      Your instructions here with {variables}
```

## Available Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Piece-wide turn count (total steps executed) |
| `{max_iterations}` | Maximum iterations allowed |
| `{step_iteration}` | Per-step iteration count (how many times THIS step has run) |
| `{previous_response}` | Previous step's output (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during piece (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/runs/20250126-143052-task-summary/reports`) |
| `{report:filename}` | Resolves to `{report_dir}/filename` (e.g., `{report:00-plan.md}`) |

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
| AI judge | `ai("condition text")` | AI evaluates the condition against agent output |
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-step results |

### Special `next` Values

- `COMPLETE` — End piece successfully
- `ABORT` — End piece with failure

### Rule Field: `appendix`

The optional `appendix` field provides a template for additional AI output when that rule is matched. Useful for structured error reporting or requesting specific information.

## Parallel Steps

Steps can execute sub-steps concurrently with aggregate evaluation:

```yaml
  - name: reviewers
    parallel:
      - name: arch-review
        agent: ../agents/default/architecture-reviewer.md
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review architecture and code quality.
      - name: security-review
        agent: ../agents/default/security-reviewer.md
        edit: false
        rules:
          - condition: approved
          - condition: needs_fix
        instruction_template: |
          Review for security vulnerabilities.
    rules:
      - condition: all("approved")
        next: supervise
      - condition: any("needs_fix")
        next: fix
```

- `all("X")`: true if ALL sub-steps matched condition X
- `any("X")`: true if ANY sub-step matched condition X
- Sub-step `rules` define possible outcomes; `next` is optional (parent handles routing)

## Report Files

Steps can generate report files in the report directory:

```yaml
# Single report file
report: 00-plan.md

# Single report with format specification
report:
  name: 00-plan.md
  format: |
    ```markdown
    # Plan
    ...
    ```

# Multiple report files
report:
  - Scope: 01-scope.md
  - Decisions: 02-decisions.md
```

## Step Options

| Option | Default | Description |
|--------|---------|-------------|
| `edit` | - | Whether the step can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous step's output to `{previous_response}` |
| `allowed_tools` | - | List of tools the agent can use (Read, Glob, Grep, Edit, Write, Bash, etc.) |
| `provider` | - | Override provider for this step (`claude` or `codex`) |
| `model` | - | Override model for this step |
| `permission_mode` | `default` | Permission mode: `default`, `acceptEdits`, or `bypassPermissions` |
| `report` | - | Report file configuration (name, format) for auto-generated reports |

## Examples

### Simple Implementation Piece

```yaml
name: simple-impl
max_iterations: 5

steps:
  - name: implement
    agent: ../agents/default/coder.md
    edit: true
    permission_mode: acceptEdits
    allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
      - condition: Cannot proceed
        next: ABORT
    instruction_template: |
      Implement the requested changes.
```

### Implementation with Review

```yaml
name: with-review
max_iterations: 10

steps:
  - name: implement
    agent: ../agents/default/coder.md
    edit: true
    permission_mode: acceptEdits
    allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: ABORT
    instruction_template: |
      Implement the requested changes.

  - name: review
    agent: ../agents/default/architecture-reviewer.md
    edit: false
    allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement
    instruction_template: |
      Review the implementation for code quality and best practices.
```

### Passing Data Between Steps

```yaml
steps:
  - name: analyze
    agent: ../agents/default/planner.md
    edit: false
    allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Analysis complete
        next: implement
    instruction_template: |
      Analyze this request and create a plan.

  - name: implement
    agent: ../agents/default/coder.md
    edit: true
    pass_previous_response: true
    permission_mode: acceptEdits
    allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: COMPLETE
    instruction_template: |
      Implement based on this analysis:
      {previous_response}
```

## Best Practices

1. **Keep iterations reasonable** — 10-30 is typical for development pieces
2. **Use `edit: false` for review steps** — Prevent reviewers from modifying code
3. **Use descriptive step names** — Makes logs easier to read
4. **Test pieces incrementally** — Start simple, add complexity
5. **Use `/eject` to customize** — Copy a builtin as starting point rather than writing from scratch
