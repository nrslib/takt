Implement according to the plan with the minimum diff while preserving existing contracts.
Refer only to files within the Report Directory shown in the Workflow Context. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

**Important**: Add unit tests alongside the implementation.
- Add unit tests for newly created classes and functions
- Update relevant tests when modifying existing code, but do not weaken existing expectations for implementation convenience
- Test file placement: follow the project's conventions
- Build verification is mandatory. After completing implementation, run the build (type check) and verify there are no type errors
- Running tests is mandatory. After build succeeds, always run tests and verify results
- When introducing new contract strings (file names, config key names, etc.), define them as constants in one place

**Additional maintenance constraints:**
- Before implementation, classify planned changes as required, related, or unnecessary
- Implement only required and related changes
- Do not use a touched file as a reason to make style improvements, renames, file moves, hook return shape changes, comment deletions, or test expectation changes
- If the existing structure can satisfy the request, do not restructure only to match common style
- After implementation, inspect the full diff and revert unnecessary changes

**Maintenance Scope output contract (create at the start of implementation):**
```markdown
# Maintenance Change Scope

## Task
{One-line task summary}

## Required Changes
| File | Reason | Requirement Mapping |
|------|--------|---------------------|
| {File} | {Reason} | {Mapped requirement} |

## Related Changes
| File | Reason | Relation to Required Change |
|------|--------|-----------------------------|
| {File} | {Reason} | {Relation} |

## Existing Contracts Preserved
| Contract | Target | Preservation |
|----------|--------|--------------|
| {Contract type} | {Target} | {What is preserved} |
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

Before running build and tests, audit your work against Policy with the following procedure.

1. Open the Policy Source path with the Read tool and obtain the full content
2. List every `##` section (do not cherry-pick)
3. Match the REJECT criteria in each listed section against your implementation
4. Inspect the full diff and check that no out-of-scope rename, move, comment deletion, UI copy change, accessible-name change, or test expectation change remains

**Required output (include headings)**
## Work Results
- {Summary of actions taken}
## Changes Made
- {Summary of required and related changes}
## Reverted Unnecessary Changes
- {Changes reverted, or "none"}
## Build Results
- {Build execution results}
## Test Results
- {Test command executed and results}
