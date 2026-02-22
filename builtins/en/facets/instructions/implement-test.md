Implement unit tests according to the test plan.
Refer only to files within the Report Directory shown in the Piece Context. Do not search or reference other report directories.

**Important: Do NOT modify production code. Only test files may be edited.**

**Actions:**
1. Review the test plan report
2. Implement the planned test cases
3. Run tests and verify all pass
4. Confirm existing tests are not broken

**Test implementation constraints:**
- Follow the project's existing test patterns (naming conventions, directory structure, helpers)
- Write tests in Given-When-Then structure
- One concept per test. Do not mix multiple concerns in a single test

**Scope output contract (create at the start of implementation):**
```markdown
# Change Scope Declaration

## Task
{One-line task summary}

## Planned changes
| Type | File |
|------|------|
| Create | `src/__tests__/example.test.ts` |

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
## Test results
- {Command executed and results}
