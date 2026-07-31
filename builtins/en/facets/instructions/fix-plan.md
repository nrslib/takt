Create an executable plan that turns every reviewer finding into one coherent fix rather than a series of local patches.

**Important:** Do not edit source files in this step. Inspect the Report Directory recursively and use it with the current code as primary evidence, not the Previous Response.

**Reference policy:**
- When a parseable Finding Contract ledger exists, its open findings are the authoritative target
- Otherwise, use the latest reviewer reports in the Report Directory as the authoritative target
- Only when needed, inspect up to two timestamped predecessors per report, newest first

**Tasks:**
1. Enumerate every target finding and acceptance condition, grouping duplicate findings into the same defect family
2. Verify each finding against the actual code and identify the shared root cause rather than its cited symptom
3. Derive every affected branch, caller, configuration entry point, and output path from the actual code
4. Define fix units, dependencies, execution order, and completion criteria for each unit
5. Define a regression test for each family and the quality gates to run after the final change
6. If requirement or design conflicts prevent a sound fix plan, state the evidence and the task-level replanning required

**Required output (include headings)**
## Plan result
- {Fix plan finalized / Task-level replanning required}
## Target scope
- {Target findings, root causes, and affected paths}
## Execution order
- {Ordered fix units, dependencies, and completion criteria}
## Verification strategy
- {Tests per family and final quality gates}
## Evidence
- {Reports inspected and supporting code locations}
