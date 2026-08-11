Create an executable plan for every actionable family accepted by the current adjudication, and for no other reviewer issue.

**Important:** Do not edit source files in this step. Inspect the Report Directory recursively and use it with the current code as primary evidence, not the Previous Response.

Treat the following current review resolution as the sole authoritative remediation target. Use individual reviewer reports only as evidence for the cause, reproduction conditions, and acceptance criteria of findings accepted by the resolution. Do not compare report timestamps or add targets from reviewer reports or old history.

Plan only the actionable families recorded in that resolution, including findings consolidated into them as `duplicate`. Treat `false_positive`, `overreach`, `out_of_scope`, `no_issue_after_verification`, `environment_unverified`, and the final gate's `adjudicated_non_actionable` prior-finding state as explicit non-implementation constraints, not optional work or opportunities for cleanup. Do not reopen or re-adjudicate them.

For each fix unit, preserve the adjudicated family IDs, acceptance criteria, and remediation boundary. Select the smallest change that satisfies those criteria without adding adjacent refactoring, compatibility paths, new guarantees, or reviewer-suggested mechanisms that the adjudication excluded. If a suggested mechanism was rejected while its underlying defect remained actionable, plan the accepted minimal correction rather than the rejected mechanism.

**Current review resolution:**
{report:review-resolution.md}

**History condition:** Only for an accepted `persists` / `reopened` issue or a new structural issue reported after a fix, inspect report history to identify the assumption missing from the earlier remediation. Do not use past reports to add or reopen remediation targets.
{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
