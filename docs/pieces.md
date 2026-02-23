# Piece Guide

This guide explains how to create and customize TAKT pieces.

## Piece Basics

A piece is a YAML file that defines a sequence of movements executed by AI agents. Each movement specifies:
- Which persona to use
- What instructions to give
- Rules for routing to the next movement

## File Locations

- Builtin pieces are embedded in the npm package (`dist/resources/`)
- `~/.takt/pieces/` — User pieces (override builtins with the same name)
- Use `takt eject <piece>` to copy a builtin to `~/.takt/pieces/` for customization

## Piece Categories

To organize the piece selection UI into categories, configure `piece_categories`.
See the [Configuration Guide](./configuration.md#piece-categories) for details.

## Piece Schema

```yaml
name: my-piece
description: Optional description
max_movements: 10
initial_movement: first-movement  # Optional, defaults to first movement

# Section maps (key → file path relative to piece YAML directory)
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

movements:
  - name: movement-name
    persona: coder                   # Persona key (references personas map)
    persona_name: coder              # Display name (optional)
    policy: coding                   # Policy key (single or array)
    knowledge: architecture          # Knowledge key (single or array)
    instruction: implement           # Instruction key (references instructions map)
    edit: true                       # Whether the movement can edit files
    required_permission_mode: edit   # Minimum permission: readonly, edit, or full
    allowed_tools:                   # Optional tool allowlist
      - Read
      - Glob
      - Grep
      - Edit
      - Write
      - Bash
    rules:
      - condition: "Implementation complete"
        next: next-movement
      - condition: "Cannot proceed"
        next: ABORT
    instruction_template: |          # Inline instructions (alternative to instruction key)
      Your instructions here with {variables}
    output_contracts:                # Report file configuration
      report:
        - name: 00-plan.md
          format: plan               # References report_formats map
```

Movements reference section maps by key name (e.g., `persona: coder`), not by file path. Paths in section maps are resolved relative to the piece YAML file's directory.

## Available Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request (auto-injected if not in template) |
| `{iteration}` | Piece-wide turn count (total movements executed) |
| `{max_movements}` | Maximum movements allowed |
| `{movement_iteration}` | Per-movement iteration count (how many times THIS movement has run) |
| `{previous_response}` | Previous movement's output (auto-injected if not in template) |
| `{user_inputs}` | Additional user inputs during piece (auto-injected if not in template) |
| `{report_dir}` | Report directory path (e.g., `.takt/runs/20250126-143052-task-summary/reports`) |
| `{report:filename}` | Inline the content of `{report_dir}/filename` |

> **Note**: `{task}`, `{previous_response}`, and `{user_inputs}` are auto-injected into instructions. You only need explicit placeholders if you want to control their position in the template.

## Rules

Rules define how each movement routes to the next movement. The instruction builder auto-injects status output rules so agents know what tags to output.

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
| Aggregate | `all("X")` / `any("X")` | Aggregates parallel sub-movement results |

### Special `next` Values

- `COMPLETE` — End piece successfully
- `ABORT` — End piece with failure

### Rule Field: `appendix`

The optional `appendix` field provides a template for additional AI output when that rule is matched. Useful for structured error reporting or requesting specific information.

## Parallel Movements

Movements can execute sub-movements concurrently with aggregate evaluation:

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

- `all("X")`: true if ALL sub-movements matched condition X
- `any("X")`: true if ANY sub-movement matched condition X
- Sub-movement `rules` define possible outcomes; `next` is optional (parent handles routing)

## Output Contracts (Report Files)

Movements can generate report files in the report directory:

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

## Movement Options

| Option | Default | Description |
|--------|---------|-------------|
| `persona` | - | Persona key (references section map) or file path |
| `policy` | - | Policy key or array of keys |
| `knowledge` | - | Knowledge key or array of keys |
| `instruction` | - | Instruction key (references section map) |
| `edit` | - | Whether the movement can edit project files (`true`/`false`) |
| `pass_previous_response` | `true` | Pass previous movement's output to `{previous_response}` |
| `allowed_tools` | - | List of tools the agent can use (Read, Glob, Grep, Edit, Write, Bash, etc.) |
| `provider` | - | Override provider for this movement (`claude`, `codex`, or `opencode`) |
| `model` | - | Override model for this movement |
| `required_permission_mode` | - | Required minimum permission mode: `readonly`, `edit`, or `full` |
| `output_contracts` | - | Report file configuration (name, format) |
| `quality_gates` | - | Quality criteria for movement completion (AI instruction) |

## Examples

### Simple Implementation Piece

```yaml
name: simple-impl
max_movements: 5

personas:
  coder: ../facets/personas/coder.md

movements:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
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
max_movements: 10

personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md

movements:
  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]
    rules:
      - condition: Implementation complete
        next: review
      - condition: Cannot proceed
        next: ABORT
    instruction_template: |
      Implement the requested changes.

  - name: review
    persona: reviewer
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

### Passing Data Between Movements

```yaml
personas:
  planner: ../facets/personas/planner.md
  coder: ../facets/personas/coder.md

movements:
  - name: analyze
    persona: planner
    edit: false
    allowed_tools: [Read, Glob, Grep, WebSearch, WebFetch]
    rules:
      - condition: Analysis complete
        next: implement
    instruction_template: |
      Analyze this request and create a plan.

  - name: implement
    persona: coder
    edit: true
    pass_previous_response: true
    required_permission_mode: edit
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
2. **Use `edit: false` for review movements** — Prevent reviewers from modifying code
3. **Use descriptive movement names** — Makes logs easier to read
4. **Test pieces incrementally** — Start simple, add complexity
5. **Use `/eject` to customize** — Copy a builtin as starting point rather than writing from scratch
