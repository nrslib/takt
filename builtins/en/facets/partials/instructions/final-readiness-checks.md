Determine whether the already-defined completion conditions are closed after specialist review and fix verification.

Procedure:
1. Decompose the original task requirements into the smallest independently verifiable units and map each unit to current code and verification results already recorded in preceding reports
2. Reconcile the current review decision with the fix plan, fix verification, and latest specialist reports, then verify that every acceptance criterion for a problem selected for repair is resolved
3. Confirm that the cumulative diff consists of changes needed by the original requirements and leaves no unauthorized deletion or contract change that contradicts those requirements
4. Only when those requirement or prior-finding checks expose an inconsistency, trace the entries, consumers, and failure paths related to that inconsistency

Do not request or inspect the execution status or logs of machine gates, including tests and builds, whether presented as quality-gate evidence or requirement-fulfillment evidence. Their absence is not grounds for remediation, replanning, or an environmental block.

Do not restart specialist reviews or exhaustively enumerate every changed identifier and same-kind location. Preferences, additional refactoring, future improvements, and concerns without evidence are not merge-blocking findings.
