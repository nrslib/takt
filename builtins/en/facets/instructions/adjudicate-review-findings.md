Adjudicate the review findings from evidence and establish the authoritative remediation set.

**Important:** Do not perform a new broad review. Consider only findings submitted by the latest review reports under the Report Directory. Inspect the current code, requirements, plan, and execution evidence only as needed.

**Tasks:**
1. For each finding, verify the claim, concrete failure scenario or specific evidence of an implementation-quality problem, file:line or reproduction evidence, and relationship to the requirements
2. Reconcile each finding with current code, requirements, and observable contracts, then map it to exactly one supported disposition: `actionable`, `duplicate`, `false_positive`, `overreach`, `out_of_scope`, `no_issue_after_verification`, or `environment_unverified`. Apply adjudication or contract-change criteria when the current prompt provides them
3. Consolidate findings with the same root cause and acceptance criteria into one family while preserving every source finding ID and report
4. When rejecting an excessive remediation mechanism, retain the underlying defect confirmed by evidence and the smallest internal fix that removes it
5. Use `environment_unverified` only when the current prompt provides environmental criteria and every condition holds; never use environment limitations to dismiss evidence of an implementation defect
6. Require replanning only when findings conflict with each other or with the requirements or plan, and the actionable set cannot be established under the current assumptions
7. Record the violated invariant or quality principle, affected contract or call paths, and observable acceptance criteria for every actionable family
8. Map every submitted finding ID to exactly one disposition row. Name the actionable family for `actionable`, name the same target family for `duplicate`, and do not include findings with any other disposition in an actionable family
9. For every actionable family, define the narrow remediation boundary: what must change to satisfy the task and what adjacent cleanup, refactoring, compatibility behavior, operational guarantee, or reviewer-suggested mechanism is explicitly excluded as unnecessary scope expansion
10. Treat this adjudication as the sole authority for the next step. A raw reviewer verdict does not authorize a fix: only `actionable` families and their `duplicate` findings may enter fix planning. Findings classified otherwise must remain excluded unless later code or requirement changes provide new evidence

Choose the result from the adjudicated set, not from reviewer vote counts. When at least one actionable family remains, return `ACTIONABLE FINDINGS` for fix planning. When none remains and no unresolved premise requires replanning, return `NO ACTIONABLE FINDINGS` so the workflow proceeds to the final merge-readiness gate.

Do not dismiss an undecidable concern by assumption; record the unresolved premise explicitly.
