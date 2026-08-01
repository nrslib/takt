Implement the finalized fix plan completely and in dependency order.

Success means completing every fix unit and defect family in the fix plan, not merely correcting the latest reported gap.

**Fix plan:**
{report:fix-plan.md}

**Important:**
- Before editing, reconcile the plan's root cause, responsibility and source of truth, impact paths, methods, evidence, and completion criteria with the current code, Report Directory, and active constraints
- Treat verifier findings as examples of incomplete coverage, not as a reduced remediation scope. After a verifier return, rerun the completion checklist for the entire plan
- Preserve public APIs, parameters, return values, events, and persisted formats unless the plan requires changing them. An obsolete internal path does not make its surrounding public contract a removal target
- If the plan conflicts under the same requirements and design assumptions, do not edit; provide evidence and report "Fix plan requires revision"
- If task-level requirements or design must change, do not edit; provide evidence and report "Task-level replanning required"

{{include:instructions/fix-plan-validity}}
{{include:instructions/fix-family-completion}}

**Required output (include headings)**
## Work result
- {Fix complete / Fix plan requires revision / Task-level replanning required}
## Changes and acceptance criteria
- {Changes by fix unit and evidence and status for findings and every invariant}
## Verification and evidence
- {Commands and results plus code, diffs, reports, and logs inspected}
