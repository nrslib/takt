Implement the finalized fix plan completely and in dependency order.

**Fix plan:**
{report:fix-plan.md}

**Important:**
- Before editing, validate the plan against the current code and evidence in the Report Directory
- Do not cherry-pick easy fix units; apply each defect family to every affected path
- If the plan is incomplete or contradictory, do not begin a partial fix; provide evidence and report "Fix plan requires revision"
- If progress requires redefining task-level requirements or design, provide evidence and report "Cannot proceed, insufficient info"

**Tasks:**
1. Implement every fix unit in the planned order
2. Add or update the regression test for each defect family
3. Recheck every affected path and acceptance condition against the changed code
4. After the final change, run every quality gate required by the plan and project

**Required output (include headings)**
## Work result
- {Fix complete / Fix plan requires revision / Cannot proceed, insufficient info}
## Changes
- {Summary by planned fix unit}
## Build result
- {Commands and results}
## Test result
- {Commands and results}
## Family coverage
- {Affected paths, tests, and completion state for each family}
## Evidence
- {Code, diffs, reports, and logs inspected}
