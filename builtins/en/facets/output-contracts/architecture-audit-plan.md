```markdown
# Architecture Audit Plan

## Enumeration Evidence
- Commands used:
  - `rg ...`
  - `rg --files ...`
- Scope notes:
  - {how modules, layers, boundaries, and entry points were enumerated}

## Module Inventory
| # | Module / Layer | Key Files | Responsibility | Main Boundaries | Risk |
|---|----------------|-----------|----------------|-----------------|------|
| 1 | {module or layer} | `src/file.ts` | {primary responsibility} | {boundary summary} | High / Medium / Low |

## Audit Targets
| # | Module / Layer | What to Verify | Priority |
|---|----------------|----------------|----------|
| 1 | {module or layer} | {dependency direction, wiring, ownership, abstraction} | High / Medium / Low |

## Audit Order
- {ordered module review plan}

## Clarifications / Risks
- {open questions or constraints}
```
