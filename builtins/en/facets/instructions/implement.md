Implement according to the plan.
Refer to files within the Report Directory shown in the Workflow Context and upstream artifacts explicitly supplied in the input. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Test requirements:**
- Add unit tests for newly created classes and functions
- Update relevant tests when modifying existing code
- Test file placement: follow the project's conventions

{{include:instructions/implement-common}}

**Change-scope record (create at the start of implementation):**
```markdown
# Change Scope Declaration

## Task
{One-line task summary}

## Planned changes
| Type | File |
|------|------|
| Create | `src/example.ts` |
| Modify | `src/routes.ts` |

## Estimated size
Small / Medium / Large

## Impact area
- {Affected modules or features}
```

**Decision record (at implementation completion, only if decisions were made):**
```markdown
# Decision Log

## 1. {Decision}
- **Context**: {Why the decision was needed}
- **Options considered**: {List of options}
- **Rationale**: {Reason for the choice}
```

**Required output (include headings)**
## Work results
- {Summary of actions taken}
## Changes made
- {Summary of changes}
## Build results
- {Build execution results}
## Test results
- {Test command executed and results}
## Handoff of unmet obligations (when applicable)
### Attempt history and constraints
- {Obligation, conditions and result for each attempted method, shared constraint, who confirmed it and its confirmation status, and sources. Distinguish reported history from direct evidence}
### Assessment of condition differences
- {For each previously assessed ineffective proposal, retain its specific changed condition, explanation, and source rather than only a general constraint summary; "none" if no such assessment was supplied. Separately identify any proposed next method's result-affecting difference and evidence}
### Handoff to planning
- {Unmet mandatory obligations, whether effective project work remains, and any required external action or answer. Explicitly hand the remaining decision about review, continued implementation, or waiting to the planning step}
