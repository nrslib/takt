Implement E2E tests according to the test plan.
Refer only to files within the Report Directory shown in the Piece Context. Do not search or reference other report directories.

**Actions:**
1. Review the test plan report
2. Implement or update tests following existing E2E layout (e.g., `e2e/specs/`)
3. Run E2E tests (minimum: `npm run test:e2e:mock`, and targeted spec runs when needed)
4. If tests fail, analyze root cause, fix test or code, and rerun
5. Confirm related existing tests are not broken

**Constraints:**
- Keep the current E2E framework (Vitest) unchanged
- Keep one scenario per test and make assertions explicit
- Reuse existing fixtures/helpers/mock strategy for external dependencies

**Scope output contract (create at the start of implementation):**
```markdown
# Change Scope Declaration

## Task
{One-line task summary}

## Planned changes
| Type | File |
|------|------|
| Create | `e2e/specs/example.e2e.ts` |

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
