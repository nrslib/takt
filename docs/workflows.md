# Workflow Guide

This guide explains how to create and customize TAKT workflows.

## Workflow Basics

A workflow is a YAML file that defines a sequence of steps executed by AI agents. Each step specifies:
- Which agent to use
- What instructions to give
- How to transition to the next step

## File Locations

Workflows can be placed in:
- `~/.takt/workflows/` - Global workflows (available in all projects)
- `.takt/workflows/` - Project-specific workflows

## Workflow Schema

```yaml
name: my-workflow
description: Optional description
max_iterations: 10
initial_step: first-step  # Optional, defaults to first step

steps:
  - name: step-name
    agent: coder           # Built-in agent or path to .md file
    allowed_tools:         # Optional tool allowlist for this step
      - Read
      - Grep
    instruction_template: |
      Your instructions here with {variables}
    transitions:
      - condition: done
        next_step: next-step
      - condition: blocked
        next_step: ABORT
    on_no_status: complete  # What to do if no status detected
```

## Available Variables

| Variable | Description |
|----------|-------------|
| `{task}` | Original user request |
| `{iteration}` | Current iteration number (1-based) |
| `{max_iterations}` | Maximum allowed iterations |
| `{previous_response}` | Previous step's output |
| `{user_inputs}` | Additional inputs during workflow |

## Transitions

### Conditions

Conditions match agent output patterns:
- `done` - Agent completed the task (`[CODER:DONE]`, etc.)
- `blocked` - Agent is blocked (`[CODER:BLOCKED]`)
- `approved` - Review passed (`[ARCHITECT:APPROVED]`)
- `rejected` - Review failed (`[ARCHITECT:REJECTED]`)

### Special Next Steps

- `COMPLETE` - End workflow successfully
- `ABORT` - End workflow with failure

### on_no_status Options

When no status pattern is detected:
- `complete` - Treat as workflow complete
- `continue` - Move to next step
- `stay` - Repeat current step

## Examples

### Simple Implementation Workflow

```yaml
name: simple
max_iterations: 5

steps:
  - name: implement
    agent: coder
    allowed_tools:
      - Read
      - Glob
      - Grep
      - Edit
      - Write
      - Bash
      - WebSearch
      - WebFetch
    instruction_template: |
      {task}
    transitions:
      - condition: done
        next_step: COMPLETE
      - condition: blocked
        next_step: ABORT
```

### Implementation with Review

```yaml
name: with-review
max_iterations: 10

steps:
  - name: implement
    agent: coder
    allowed_tools:
      - Read
      - Glob
      - Grep
      - Edit
      - Write
      - Bash
      - WebSearch
      - WebFetch
    instruction_template: |
      {task}
    transitions:
      - condition: done
        next_step: review
      - condition: blocked
        next_step: ABORT

  - name: review
    agent: architect
    allowed_tools:
      - Read
      - Glob
      - Grep
      - WebSearch
      - WebFetch
    instruction_template: |
      Review the implementation for:
      - Code quality
      - Best practices
      - Potential issues
    transitions:
      - condition: approved
        next_step: COMPLETE
      - condition: rejected
        next_step: implement
```

### Passing Data Between Steps

```yaml
steps:
  - name: analyze
    agent: architect
    allowed_tools:
      - Read
      - Glob
      - Grep
      - WebSearch
      - WebFetch
    instruction_template: |
      Analyze this request and create a plan: {task}
    transitions:
      - condition: done
        next_step: implement

  - name: implement
    agent: coder
    pass_previous_response: true  # Enable {previous_response}
    allowed_tools:
      - Read
      - Glob
      - Grep
      - Edit
      - Write
      - Bash
      - WebSearch
      - WebFetch
    instruction_template: |
      Implement based on this analysis:
      {previous_response}
    transitions:
      - condition: done
        next_step: COMPLETE
```

## Best Practices

1. **Keep iterations reasonable** - 5-15 is typical
2. **Always handle blocked state** - Provide an escape path
3. **Use descriptive step names** - Makes logs easier to read
4. **Test workflows incrementally** - Start simple, add complexity
