Implement the finalized fix plan completely and in dependency order.

Success means completing every fix unit and every completion obligation derived from the fix plan, not merely correcting the latest reported gap.

**Fix plan:**
{report:fix-plan.md}

**Important:**
- Before editing, reconcile the plan's root cause, responsibility and source of truth, impact paths, methods, evidence, and completion criteria with the current code, Report Directory, and active constraints
- Before editing, decompose each invariant into atomic completion obligations that identify the affected path and a counterexample that would fail when the invariant is broken; close behavior correction, consumer migration, obsolete-path removal, and existing-contract preservation separately before declaring completion
- Preserve public APIs, parameters, return values, events, commands, configuration, paths, and persisted formats outside the requested change scope. For a replacement, close current-consumer migration, obsolete-path removal, and each explicitly required support target as separate completion obligations
- If the plan conflicts under the same requirements and design assumptions, do not edit; provide evidence and report "Fix plan requires revision"
- If task-level requirements or design must change, do not edit; provide evidence and report "Task-level replanning required"

{{include:instructions/fix-plan-validity}}
{{include:instructions/invariant-recurrence}}
{{include:instructions/contract-family-fix}}

{{include:instructions/established-invariants-scan}}
{{include:instructions/post-edit-self-scan}}

**Required output (include headings)**
## Work result
- {Fix complete / Fix plan requires revision / Task-level replanning required}
## Changes and acceptance criteria
- {Changes by fix unit and falsification method, evidence, and status for findings and every completion obligation}
## Verification and evidence
- {Commands and results plus code, diffs, reports, and logs inspected}
