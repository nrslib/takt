{{include:instructions/fix-plan-purpose}}

**Important:** Do not edit source files in this step. Instead of the Previous Response, inspect the Report Directory recursively as supporting evidence and use the live state with the current code as primary evidence.

**Reference policy:**
- Use the engine-provided live Finding Contract ledger summary / Finding state as the authoritative remediation target, and plan only open findings whose lifecycle is `new`, `persists`, or `reopened`
- Use individual reviewer and final-gate reports only as evidence for causes, reproduction conditions, and acceptance criteria of findings in the authoritative target; do not independently reopen a resolved or closed finding
- `findings[].rawFindingIds` provides supporting traceability to individual reviews; it is not an alternative source of truth
- Limit the "unresolved issues" grouped by root-cause analysis to open findings whose lifecycle is `new`, `persists`, or `reopened` in this live state

**History condition:** Only for `persists` / `reopened` findings or a new structural issue reported after a fix, inspect each report's history and identify the assumption missing from the earlier remediation. Do not use past reports to add or reopen findings.
{{include:instructions/review-report-history}}

{{include:instructions/fix-plan-common}}
