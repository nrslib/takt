Write tests from the plan before implementing production code.
Refer only to files in the Report Directory shown in Workflow Context. Do not search or reference other report directories.

**Important: Do NOT create or modify production code. Only test files may be created.**

{{include:instructions/change-contract-traceability}}
{{include:instructions/test-contract-discrimination}}

**Test boundaries:**
- Decide whether to create, update, or delete tests from observable contracts, and apply test-related judgment criteria when the current prompt provides them
- Keep one concept per test and follow existing naming, placement, and helper conventions
- Failures caused by not-yet-implemented production code are expected at this stage; fix test defects that would remain afterward

{{include:instructions/post-edit-self-scan}}
