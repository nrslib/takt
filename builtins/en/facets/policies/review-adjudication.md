# Review Finding Adjudication Policy

Separate a finding's technical validity from authority to remediate it in this task, and establish only the authorized remediation set.

{{include:policies/review-scope-authority}}

## Principles

| Principle | Criteria |
|-----------|----------|
| Evidence first | Base adjudication only on facts confirmed by the current code, requirements, reports, or execution evidence |
| Separate observation from authority | A technically valid defect is not a remediation target without a basis authorizing its repair in this task |
| Limit authorization bases | Authorize only direct acceptance-criterion violations, regressions introduced by the current diff, required consumer migrations, and closure of an accepted contract family |
| Close families vertically | Close an accepted family through every actual path carrying the same invariant, from definition to terminal or API output |
| Preserve horizontal boundaries | Proximity, general quality, or presence in the same file does not authorize work on a neighboring contract or improvement |
| Minimal internal fix | Define the smallest internal fix that removes the confirmed defect while preserving existing observable contracts |
| Reject excessive mechanisms | Do not require new external behavior, contracts, limits, guarantees, or operational requirements beyond the confirmed defect, such as atomicity, transactions, rollback, resource caps, or compatibility routes |
| Separate proposal from authority | Reviewer severity, REJECT, suggested remediation, and a critical label do not by themselves authorize remediation in this task |
| One disposition | Map every finding ID to exactly one disposition and consolidate only findings with the same cause into one family |
| Limit replanning | Require replanning only when findings, requirements, or the plan conflict and the remediation set cannot be established under current assumptions |

## Remediation scope

| Situation | Verdict |
|-----------|---------|
| An initial review confirms a violation in the presented changed family | `actionable`; assign `direct_acceptance_criterion_violation` during adjudication. The initial review's `not applicable` records that follow-up classification was not applicable and is not copied into the actionable family |
| A follow-up finding has exactly one Authorization Basis under the exclusive decision order in Finding and Remediation Authority | `actionable`, or `duplicate` into an existing family with the same cause and acceptance criteria |
| A violation of a real separate contract is technically confirmed but has no basis under that exclusive decision order | `out_of_scope` |
| The observed current behavior is accurate, but no contract makes it defective and the finding requests only a stronger mechanism, guarantee, or general practice | `overreach` |

Do not invent a separate Authorization Basis classification rule in adjudication. For an initial-review finding, derive `direct_acceptance_criterion_violation` from the confirmed violation of the presented original acceptance criterion. For a follow-up finding, validate the reviewer's causal evidence under the included authority policy; when the recorded value is inconsistent or contains multiple values, replace it with the exact single machine value selected by that policy and record the reason for the mismatch.

## Suggested mechanism versus underlying defect

When a finding combines a real defect with an excessive remediation mechanism, judge factual validity, remediation authority, and remediation method separately. When the underlying defect has an authorization basis, classify it as `actionable` or `duplicate` in the same family, and record only the necessary minimal fix and preservation of existing contracts in the acceptance criteria. When a violation of a real separate contract is technically confirmed but lacks an authorization basis, classify it as `out_of_scope`. When only the current behavior is factually observed, no contract makes that behavior a violation, and adopting the proposed mechanism or guarantee is what would create the alleged defect, classify it as `overreach`.

## Non-actionable dispositions

Use `duplicate` only for findings with the same root cause and acceptance criteria, and name the target family. Use `false_positive` / `no_issue_after_verification` when current code or evidence contradicts the claim, `out_of_scope` when a violation of a real separate contract is confirmed but lacks remediation authority, `overreach` when no contract makes the observed behavior defective and the request adds a mechanism or guarantee beyond the evidence or authority, and `environment_unverified` only when every environmental condition is satisfied and no implementation defect can be confirmed. Do not treat a finding that merely lacks evidence from an unrequired environment as a disproved claim under `no_issue_after_verification`; when only the environmental conditions are established and no implementation defect is confirmed, use `environment_unverified`. Do not use environmental limitations to dismiss evidence of an implementation defect.

## Complete adjudication

Record one authorization basis for every actionable finding. For every family, record its violated invariant, relevant actual paths across definition, production, normalization, validation, every consumer, retry, fallback, parallel execution, persistence, restoration, and terminal or API output, observable acceptance criteria, and remediation boundary. When findings in one family have different bases, preserve the family identity but use one row per basis; never combine or overwrite the values. Never send an unresolved actionable item to completion because of severity, discovery timing, discovery rate, or the fact that it was recorded. Do not dismiss an undecidable concern by assumption; record it as an unresolved premise.
