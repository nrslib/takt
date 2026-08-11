# Review Finding Adjudication Policy

Separate a finding's technical validity from authority to remediate it in this task, and establish only the authorized remediation set.

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
| Directly violates an original requirement or acceptance criterion | `actionable` — `direct_acceptance_criterion_violation` |
| The current diff or repair introduced a regression that did not exist before it | `actionable` — `remediation_regression` |
| A current consumer must migrate for the changed or replaced contract to be valid | `actionable` — `required_consumer_migration` |
| An unvisited consumer violates the same invariant as an already accepted contract family | `actionable` or `duplicate` into that family — `accepted_family_unvisited_consumer` |
| Technically valid quality defect or improvement in another contract without one of the bases above | `out_of_scope` |
| Requests only a stronger mechanism, guarantee, or general practice without evidence of an authorized defect | `overreach` |

## Suggested mechanism versus underlying defect

When a finding combines a real defect with an excessive remediation mechanism, judge factual validity, remediation authority, and remediation method separately. When the underlying defect has an authorization basis, classify it as `actionable` or `duplicate` in the same family, and record only the necessary minimal fix and preservation of existing contracts in the acceptance criteria. When the defect is technically valid but lacks an authorization basis, classify it as `out_of_scope`; use `overreach` when no defect is evidenced and the finding requests only a mechanism.

## Non-actionable dispositions

Use `duplicate` only for findings with the same root cause and acceptance criteria, and name the target family. Use `false_positive` / `no_issue_after_verification` when current code or evidence contradicts the claim, `out_of_scope` for a confirmed defect or improvement in another contract without remediation authority, `overreach` for a mechanism or guarantee beyond the evidence or authority, and `environment_unverified` only when every environmental condition is satisfied and no implementation defect can be confirmed. Do not use environmental limitations to dismiss evidence of an implementation defect.

## New findings in follow-up reviews

Keep follow-up remediation converging toward closure. When accepting a new finding from a follow-up review, record one of `accepted_family_unvisited_consumer`, `remediation_regression`, `direct_acceptance_criterion_violation`, or `required_consumer_migration`, plus the reason it was absent from the initial round. Prior existence does not make an unvisited consumer in an accepted family non-actionable; attach it to that family rather than creating a horizontal family. A horizontal improvement to a neighboring contract does not enter fix planning as a new finding.

## Complete adjudication

For every actionable family, record its authorization basis, violated invariant, relevant actual paths across definition, production, normalization, validation, every consumer, retry, fallback, parallel execution, persistence, restoration, and terminal or API output, observable acceptance criteria, and remediation boundary. Never send an unresolved actionable item to completion because of severity, discovery timing, discovery rate, or the fact that it was recorded. Do not dismiss an undecidable concern by assumption; record it as an unresolved premise.
