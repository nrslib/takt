# Agent Guide

This guide explains how to configure custom personas in TAKT.

## Built-in Personas

TAKT includes built-in personas (located in `builtins/{lang}/facets/personas/`):

| Persona | Description |
|---------|-------------|
| **planner** | Task analysis, spec investigation, and implementation planning |
| **coder** | Implements features and fixes bugs |
| **ai-antipattern-reviewer** | Reviews for AI-specific anti-patterns (hallucinated APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Reviews architecture and code quality, verifies spec compliance |
| **security-reviewer** | Security vulnerability assessment |
| **supervisor** | Final verification, validation, and approval |

## Custom Personas

### Creating a Persona File

Create a Markdown file with your persona instructions.

Custom personas are loaded from:

- `~/.takt/personas/<name>.md` (name-based persona)
- explicit path (for example `~/.takt/facets/personas/<name>.md`, or a repertoire facet path) in piece YAML

### Specifying Personas in Pieces

In piece YAML, personas are usually configured via `personas` section map:

```yaml
# Section map at top level (key -> file path relative to piece YAML)
personas:
  coder: ../facets/personas/coder.md
  reviewer: ../facets/personas/architecture-reviewer.md

movements:
  - name: implement
    persona: coder       # References the key in the section map
  - name: review
    persona: reviewer    # References the key in the section map
```

You can also specify a persona file path directly:

```yaml
movements:
  - name: review
    persona: ~/.takt/personas/my-reviewer.md
```

If `persona` is a bare name and no section-map entry exists, TAKT checks `~/.takt/personas/<name>.md` as a fallback.

> **Note**: Personas do not need to output status markers manually. The engine auto-injects status routing rules into the generated instructions.

## Behavior Notes

`agents.yaml` is not used in the current TAKT implementation.
Use `~/.takt/personas/<name>.md` or direct file references in piece YAML instead.

## Best Practices

1. **Clear role definition** — State what the persona does and does not do
2. **Minimal permission scope** — Keep rules and instructions focused
3. **Use `edit: false`** — Review personas should not modify files
4. **Focused scope** — One persona, one responsibility
5. **Customize via `/eject`** — Copy builtin personas to `~/.takt/` and modify locally
