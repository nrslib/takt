# Review Finding Adjudication Policy

Separate finding validity, direct task relationship, and remediation authority when establishing the authoritative remediation set.

## Principles

| Principle | Criteria |
|-----------|----------|
| Evidence first | Base adjudication only on facts confirmed by the current code, requirements, reports, or execution evidence |
| Direct relationship | Include only problems directly related to the changed area or the change's correctness, contracts, or wiring |
| Retain quality defects | Retain confirmed DRY, responsibility-boundary, type-safety, dead-code, test-quality, and wiring defects that are directly related, regardless of severity |
| Minimal internal fix | Define the smallest internal fix that removes the confirmed defect while preserving existing observable contracts |
| Reject excessive mechanisms | Do not require new external behavior, contracts, limits, guarantees, or operational requirements beyond the confirmed defect, such as atomicity, transactions, rollback, resource caps, or compatibility routes |
| Separate proposal from authority | Reviewer severity, REJECT, and suggested remediation do not by themselves authorize remediation in this task |
| One disposition | Map every finding ID to exactly one disposition and consolidate only findings with the same cause into one family |
| Limit replanning | Require replanning only when findings, requirements, or the plan conflict and the remediation set cannot be established under current assumptions |

## Remediation scope

| Situation | Verdict |
|-----------|---------|
| Violates a requirement or acceptance criterion | `actionable` |
| Breaks a required execution path, contract, or wiring | `actionable` |
| A directly related implementation-quality defect is confirmed | `actionable` |
| A quality improvement is present only because the file was changed and does not affect correctness | `out_of_scope` |
| Broad refactoring or future improvement is unrelated to the task | `out_of_scope` |

## Suggested mechanism versus underlying defect

When a finding combines a real defect with an excessive remediation mechanism, judge factual validity and remediation authority separately. If a minimal internal fix can remove the underlying defect, classify the finding as `actionable` or `duplicate` in the same family, and record only the necessary internal fix and preservation of existing contracts in the acceptance criteria. Use `overreach` only when no defect is evidenced and the finding requests a mechanism alone.

## Non-actionable dispositions

Use `duplicate` only for findings with the same root cause and acceptance criteria, and name the target family. Use `false_positive` / `no_issue_after_verification` when current code or evidence contradicts the claim, `out_of_scope` for quality improvements without a direct relationship, and `environment_unverified` only when every environmental condition is satisfied and no implementation defect can be confirmed. Do not use environmental limitations to dismiss evidence of an implementation defect.

## Complete adjudication

For every actionable family, record the violated invariant or quality principle, affected contract or call paths, and observable acceptance criteria. Do not dismiss an undecidable concern by assumption; record it as an unresolved premise.
