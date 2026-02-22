Implement according to the plan.
Refer only to files within the Report Directory shown in the Piece Context. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Important**: Add unit tests alongside the implementation.
- Add unit tests for newly created classes and functions
- Update relevant tests when modifying existing code
- Test file placement: follow the project's conventions
- Build verification is mandatory. After completing implementation, run the build (type check) and verify there are no type errors
- Running tests is mandatory. After build succeeds, always run tests and verify results
- When introducing new contract strings (file names, config key names, etc.), define them as constants in one place

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
