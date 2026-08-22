Implement according to the plan within the causally related scope while preserving existing contracts outside the requested change scope.
Refer only to files within the Report Directory shown in the Workflow Context. Do not search or reference other report directories.
Use reports in the Report Directory as the primary source of truth. If additional context is needed, you may consult Previous Response and conversation history as secondary sources (Previous Response may be unavailable). If information conflicts, prioritize reports in the Report Directory and actual file contents.

{{include:instructions/implement-common}}
- Update relevant tests when modifying existing code, but do not weaken existing expectations for implementation convenience

**Additional maintenance constraints:**
- Before implementation, organize each candidate change by Contract ID, change location (`file:line`), causal basis, and `required` or `related` classification
- For each existing contract preserved outside the change scope, record its Contract ID, evidence of the current contract, preservation mechanism, and verification evidence
- For each replaced contract, record its Contract ID, old path, current-consumer migration status, required old-path removal status, new behavior, and supporting evidence
- For each unnecessary candidate, record its location, candidate change, a disposition of not introduced, removed because this implementation step introduced it, or explicitly authorized, and the reason
- Implement only `required` and `related` changes
- Do not use a touched file as a reason to make style improvements, renames, file moves, changes to public type names, return structures, or consumer interfaces, comment deletions, or test expectation changes
- Do not make structural changes that are not causally related to the request
- Do not use an absence-only test of an old specification as a substitute for positive verification of the new specification. Preserve negative tests that verify an explicit rejection or exclusion contract
- Match the pattern of an existing implementation of the same kind; do not introduce a novel style
- After implementation, inspect the full diff and remove only unnecessary changes confirmed to have been introduced by this implementation step. Do not revert pre-existing changes or necessary changes from another step

**Decision records:**
- Only when a non-obvious decision exists, record the decision, supporting code, requirement, or execution evidence, alternatives considered and why they were rejected, and affected Contract IDs

**Additional pre-completion checks:**
1. Inspect the full diff and check that no unauthorized rename, move, comment deletion, UI copy change, accessible-name change, or test expectation change remains
2. When a specification change replaces an old design, confirm that positive verification of the new specification exists and that absence of the old design is not used as its substitute. Do not remove a negative test that verifies an explicit rejection or exclusion contract

**Required output (include headings)**
## Work Results
- {Summary of actions taken}
## Changes Made
- {Summary of required and related changes}
## Reverted Unnecessary Changes
- {Changes introduced and then reverted by this implementation step, or "none"}
## Build Results
- {Build execution results}
## Test Results
- {Test command executed and results}
