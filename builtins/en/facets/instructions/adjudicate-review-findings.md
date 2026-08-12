Adjudicate the review findings from evidence and establish the authoritative remediation set.

**Important:** Do not perform a new broad review. Consider only findings submitted by the latest review reports under the Report Directory. Inspect the current code, requirements, plan, and execution evidence only as needed.

**Tasks:**
1. For each finding, verify its technical claim, concrete failure scenario or specific evidence of an implementation-quality problem, and file:line or reproduction evidence
2. Separately determine what authorizes remediation: a direct acceptance-criterion violation, a regression introduced by the current diff, a required consumer migration, or closure of an accepted contract family. Severity, REJECT, and a suggested fix do not establish authority
3. Reconcile each finding with current code, requirements, and observable contracts, then map it to exactly one supported disposition: `actionable`, `duplicate`, `false_positive`, `overreach`, `out_of_scope`, `no_issue_after_verification`, or `environment_unverified`. Apply adjudication or contract-change criteria when the current prompt provides them
4. Consolidate findings only when they have the same root cause, source of truth, invariant, and acceptance criteria. Close that family vertically from definition through terminal or API output without merging a neighboring contract. A previously unvisited consumer needed to close an already authorized family may be added as `accepted_family_unvisited_consumer` or `required_consumer_migration` only when it shares all four of those family properties; do not use this exception to explore an adjacent contract
5. When rejecting an excessive remediation mechanism, retain the underlying defect and smallest internal fix only when the defect has remediation authority. Keep a technically valid but unauthorized horizontal improvement out of the remediation set as `out_of_scope`
6. For a new follow-up finding, record one of `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`, plus why it was absent from the initial round
7. Use `environment_unverified` only when the current prompt provides environmental criteria and every condition holds; never use environment limitations to dismiss evidence of an implementation defect
8. Require replanning only when findings conflict with each other or with the requirements or plan, and the actionable set cannot be established under the current assumptions
9. Record the authorization basis, violated invariant, affected contract paths, and observable acceptance criteria for every actionable family
10. Map every submitted finding ID to exactly one disposition row. Name the actionable family for `actionable`, name the same target family for `duplicate`, and do not include findings with any other disposition in an actionable family
11. For every actionable family, define the narrow remediation boundary: what must change to satisfy the task and what adjacent cleanup, refactoring, compatibility behavior, operational guarantee, or reviewer-suggested mechanism is explicitly excluded as unnecessary scope expansion
12. Treat this adjudication as the sole authority for the next step. A raw reviewer verdict does not authorize a fix: only `actionable` families and their `duplicate` findings may enter fix planning. Findings classified otherwise must remain excluded unless later code or requirement changes provide new evidence

Choose the result from the adjudicated set, not from reviewer vote counts. When at least one actionable family remains, return `ACTIONABLE FINDINGS` for fix planning regardless of severity, discovery timing, discovery rate, or the fact that it was recorded. Return `NO ACTIONABLE FINDINGS` only when none remains and no unresolved premise requires replanning, so the workflow proceeds to the final merge-readiness gate.

Do not dismiss an undecidable concern by assumption; record the unresolved premise explicitly.
