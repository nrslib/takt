Implement according to the plan within the causally related scope while preserving existing contracts outside the requested change scope. Do not keep an old contract targeted for replacement alongside the new contract unless backward compatibility or migration is explicitly required.
Refer only to files within the Report Directory shown in the Workflow Context. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

{{include:instructions/implement-common}}
- Update relevant tests when modifying existing code, but do not weaken existing expectations for implementation convenience

**Additional maintenance constraints:**
- Before implementation, classify planned changes as required, related, or unnecessary
- Implement only required and related changes
- Do not use a touched file as a reason to make style improvements, renames, file moves, hook return shape changes, comment deletions, or test expectation changes
- Do not make structural changes that are not causally related to the request
- When a specification change removes an old design, do not leave code or tests that only verify the absence of the old specification
- After implementation, inspect the full diff and revert unnecessary changes

**Output contracts:**
- At implementation start, organize required changes, related changes, and preserved existing contracts in the shape expected by the `maintenance-scope` output contract.
- After implementation, only when a non-obvious decision exists, create a decision log following the `coder-decisions` output contract.

**Additional pre-completion checks:**
1. Inspect the full diff and check that no out-of-scope rename, move, comment deletion, UI copy change, accessible-name change, or test expectation change remains
2. If a specification change replaced an old design, check that no code or test remains that only verifies absence of the old design

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
