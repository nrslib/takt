# Review Finding Adjudication Policy

Separate a finding's technical validity from whether this task requires its remediation, and establish only the necessary remediation targets.

## Principles

| Principle | Criteria |
|-----------|----------|
| Evidence first | Base adjudication only on facts confirmed by the current code, requirements, reports, or execution evidence |
| Separate observation from remediation scope | A technically valid defect is not a remediation target unless this task requires its repair |
| Limit remediation targets | Remediate only direct acceptance-criterion violations, regressions introduced by the current diff, required consumer migrations, and closure of a problem already accepted for remediation |
| Inspect affected paths | For each problem accepted for remediation, inspect every actual path related to the same cause and invariant, from definition to terminal or API output |
| Exclude adjacent problems | Proximity, general quality, or presence in the same file does not justify work on a neighboring contract or improvement |
| Minimum necessary fix | Define the smallest internal fix that removes the confirmed defect while preserving existing observable contracts |
| Reject excessive mechanisms | Do not require new external behavior, contracts, limits, guarantees, or operational requirements beyond the confirmed defect, such as atomicity, transactions, rollback, resource caps, or compatibility routes |
| Separate proposals from remediation targets | Do not include a finding in this task's remediation merely because of reviewer severity, REJECT, suggested remediation, or a critical label |
| Decide every finding | Map every finding ID to exactly one disposition and consolidate only findings with the same cause and acceptance criteria into one family |
| Limit replanning | Require replanning only when findings, requirements, or the plan conflict and the remediation set cannot be established under current assumptions |

## Remediation scope

| Situation | Verdict |
|-----------|---------|
| Directly violates an original requirement or acceptance criterion | Include it in remediation |
| The current diff or repair introduced a regression that did not exist before it | Include it in remediation |
| A current consumer must migrate for the changed or replaced contract to be valid | Include it in remediation |
| An unvisited consumer has the same cause and violates the same invariant as a problem already accepted for remediation | Include it in remediation or consolidate it as a duplicate with the same cause |
| Technically valid quality defect or improvement in another contract that does not match a situation above | `out_of_scope` |
| Requests only a stronger mechanism, guarantee, or general practice without evidence of a defect that requires remediation | `overreach` |

## Suggested mechanism versus underlying defect

When a finding combines a real defect with an excessive remediation mechanism, judge factual validity, the reason to remediate it now, and the remediation method separately. When the underlying defect requires remediation under the rules above, classify it as `actionable` or consolidate it as a `duplicate` with the same cause, and record only the necessary minimal fix and preservation of existing contracts in the acceptance criteria. When a violation of a real separate contract is technically confirmed but does not require remediation now, classify it as `out_of_scope`. When only the current behavior is factually observed, no contract makes that behavior a violation, and adopting the proposed mechanism or guarantee is what would create the alleged defect, classify it as `overreach`.

## Non-actionable dispositions

Use `duplicate` only for findings with the same root cause and acceptance criteria, and name the target family. Use `false_positive` / `no_issue_after_verification` when current code or evidence contradicts the claim, `out_of_scope` when a violation of a real separate contract is confirmed but is not a remediation target in this task, `overreach` when no contract makes the observed behavior defective and the request adds a mechanism or guarantee beyond what is necessary, and `environment_unverified` only when every environmental condition is satisfied and no implementation defect can be confirmed. Do not treat a finding that merely lacks evidence from an unrequired environment as a disproved claim under `no_issue_after_verification`; when only the environmental conditions are established and no implementation defect is confirmed, use `environment_unverified`. Do not use environmental limitations to dismiss evidence of an implementation defect.

## Complete adjudication

For every actionable family, record why it requires remediation now, its violated invariant, relevant actual paths across definition, production, normalization, validation, every consumer, retry, fallback, parallel execution, persistence, restoration, and terminal or API output, observable acceptance criteria, and remediation boundary. Never send an unresolved actionable item to completion because of severity, discovery timing, discovery rate, or the fact that it was recorded. Do not dismiss an undecidable concern by assumption; record it as an unresolved premise.
