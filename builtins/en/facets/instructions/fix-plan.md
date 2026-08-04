{{include:instructions/fix-plan-purpose}}

**Important:** Do not edit source files in this step. Inspect the Report Directory recursively and use it with the current code as primary evidence, not the Previous Response.

**Reference policy:** Use the latest reviewer reports in the Report Directory as the authoritative remediation target; do not compare timestamps across report files or add targets from old history. Use individual reviewer and final-gate reports only as evidence for causes, reproduction conditions, and acceptance criteria of issues in that target; do not independently reopen issues that the target does not classify for remediation.

**History condition:** Only for `persists` / `reopened` issues or a new structural issue reported after a fix, inspect each report's history and identify the assumption missing from the earlier remediation. Do not use past reports to add or reopen remediation targets.
{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
