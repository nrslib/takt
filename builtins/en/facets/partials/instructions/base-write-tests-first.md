Write tests from the plan before implementing production code.
Refer only to reports in the Report Directory shown in Workflow Context. Do not search or reference other report directories. You may inspect repository source, existing tests, and configuration needed to verify the contract.

**Important: Do NOT create or modify production code. Only test files may be created.**

{{include:instructions/contract-family-test-authoring}}
{{include:instructions/change-contract-traceability}}
{{include:instructions/test-contract-discrimination}}

**Test boundaries:**
- Decide whether to create, update, or delete tests from observable contracts, and apply test-related judgment criteria when the current prompt provides them
- Failures caused by not-yet-implemented production code are expected at this stage; fix test defects that would remain afterward

{{include:instructions/post-edit-self-scan}}
