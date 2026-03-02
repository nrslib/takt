Implement according to the plan, making existing tests pass.
Refer only to files within the Report Directory shown in the Piece Context. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Important**: Tests have already been written. Implement production code to make existing tests pass.
- Review existing test files and understand the expected behavior
- Implement production code to make tests pass
- Tests are already written so additional tests are generally unnecessary, but may be added if needed
- If test modifications are needed, document the reasons in the Decisions output contract before modifying
- Build verification is mandatory. After completing implementation, run the build (type check) and verify there are no type errors
- Running tests is mandatory. After build succeeds, always run tests and verify all tests pass
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

**Pre-completion self-check (required):**
Before running build and tests, verify the following:
- If new parameters/fields were added, grep to confirm they are actually passed from call sites
- For any `??`, `||`, `= defaultValue` usage, confirm fallback is truly necessary
- Verify no replaced code/exports remain after refactoring
- Verify no features outside the task specification were added
- Verify no if/else blocks call the same function with only argument differences
- Verify new code matches existing implementation patterns (API call style, type definition style, etc.)

**Required output (include headings)**
## Work results
- {Summary of actions taken}
## Changes made
- {Summary of changes}
## Build results
- {Build execution results}
## Test results
- {Test command executed and results}
