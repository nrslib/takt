Implement according to the plan, making existing tests pass.
Refer only to files within the Report Directory shown in the Workflow Context. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Important**: Tests have already been written. Implement production code to make existing tests pass.
- Review existing test files and understand the expected behavior
- Implement production code to satisfy the plan requirements and contract map, using existing tests as executable evidence rather than as the upper bound of scope
- Tests are already written so additional tests are generally unnecessary, but may be added if needed
- If test modifications are needed, document the reasons in the Decisions output contract before modifying

{{include:instructions/implement-common}}

**Scope output contract (create at the start of implementation):**
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

**Decisions output contract (at implementation completion, only if decisions were made):**
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
