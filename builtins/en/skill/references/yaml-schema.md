# Workflow YAML Schema Reference

This document defines the workflow YAML structure. It does not include concrete workflow definitions.

## Top-Level Fields

```yaml
name: workflow-name           # Required workflow name. Workflow categories also refer to this name.
description: Description      # Optional
max_steps: 10                 # Maximum iteration count. A default may apply when omitted.
initial_step: plan            # First step name. Defaults to the first item in steps when omitted.

workflow_config:              # Optional workflow-level provider/runtime settings.
  provider_options:
    codex:
      network_access: true

policies:                     # Optional section map: key -> file path.
  coding: ../policies/coding.md
personas:
  coder: ../personas/coder.md
instructions:
  implement: ../instructions/implement.md
report_formats:
  review: ../output-contracts/review.md
knowledge:
  architecture: ../knowledge/architecture.md

steps: [...]                  # Recommended step definition array.
loop_monitors: [...]          # Optional loop monitor definitions.
```

Section map paths are resolved relative to the workflow YAML file directory. Step definitions refer to section map keys, not raw paths.

## Step Definitions

### Normal Step

```yaml
- name: step-name
  persona: coder
  policy: coding
  instruction: implement
  knowledge: architecture
  edit: true
  required_permission_mode: edit
  session: refresh
  pass_previous_response: true
  allowed_tools: [...]
  output_contracts: [...]
  quality_gates: [...]
  rules:
    - condition: done
      next: COMPLETE
```

`instruction` is the canonical field. It resolves in this order: section map key, path, three-layer facet lookup, then inline content. `instruction_template` is not accepted.

### Parallel Step

```yaml
- name: reviewers
  parallel:
    - name: arch-review
      persona: architecture-reviewer
      policy: review
      knowledge: architecture
      rules:
        - condition: approved
          next: COMPLETE
  rules:
    - condition: all("COMPLETE")
      next: fix
```

Parallel parent steps use `parallel`. Do not combine `parallel`, `arpeggio`, `team_leader`, or `call` on the same step.

### Arpeggio Step

```yaml
- name: batch
  arpeggio:
    items: [...]
    step:
      name: item-worker
      persona: coder
      rules:
        - condition: done
          next: COMPLETE
  rules:
    - condition: all("COMPLETE")
      next: COMPLETE
```

### Team Leader Step

```yaml
- name: team
  team_leader:
    persona: team-leader
    worker_persona: coder
    max_workers: 4
  rules:
    - condition: done
      next: COMPLETE
```

### Workflow Call Step

```yaml
- name: call-child
  call: ./child.yaml
  rules:
    - condition: COMPLETE
      next: COMPLETE
```

The `call` path is resolved relative to the current workflow YAML file unless it is absolute or home-relative.

## Rules

Each step must define `rules`. Rule conditions support tag strings, `ai("...")`, and aggregate forms such as `all("COMPLETE")` or `any("FAILED")`.

```yaml
rules:
  - condition: approved
    next: COMPLETE
  - condition: ai("needs another revision")
    next: fix
```

`next` is a step name or a terminal marker such as `COMPLETE` or `ABORT`.

## Facet References

Facet maps may reference files under the same builtins, project, or user resource root.

```yaml
personas:
  coder: ../facets/personas/coder.md
policies:
  coding: ../facets/policies/coding.md
instructions:
  implement: ../facets/instructions/implement.md
knowledge:
  architecture: ../facets/knowledge/architecture.md
report_formats:
  review: ../facets/output-contracts/review.md
```

Steps reference the keys:

```yaml
- name: implement
  persona: coder
  policy: coding
  instruction: implement
  knowledge: architecture
  output_contracts:
    - review
```

## Builder Constraints

- Design workflows first, then create or update the facets required by those workflows.
- Keep builtins `en` and `ja` resources synchronized when editing builtins scope.
- Do not edit related workflows or facets unless the user approved those candidate paths.
- Keep generated YAML parseable and compatible with the workflow schema.
