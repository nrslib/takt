Determine whether the already-defined completion conditions are closed after specialist review and fix verification.

Procedure:
1. Decompose the original task requirements into the smallest independently verifiable units and map each unit to current code or execution evidence
2. Reconcile the current review resolution expanded in the instruction with the fix plan, fix verification, and latest specialist reports, then verify that every actionable acceptance criterion is resolved
3. For each quality gate required by this task, such as build, tests, or functional checks, verify the executed target, result, and unverified scope from actual evidence
4. Confirm that the cumulative diff consists of changes needed by the original requirements and leaves no out-of-scope deletion, contract change, or weakened test
5. Only when those requirement, prior-finding, or quality-gate checks expose an inconsistency, trace the entries, consumers, and failure paths related to that inconsistency

Do not restart specialist reviews or exhaustively enumerate every changed identifier and same-kind location. Preferences, additional refactoring, future improvements, and concerns without evidence are not merge-blocking findings.
{{include:instructions/review-pr-context}}
