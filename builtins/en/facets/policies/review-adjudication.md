# Review Finding Adjudication Policy

Separate a finding's technical validity from authority to remediate it in this task. Adjudicate only the findings submitted in the current review round.

{{include:policies/review-scope-authority}}

## Principles

| Principle | Criteria |
|-----------|----------|
| Evidence first | Base adjudication only on facts confirmed by the current code, requirements, reports, or execution evidence |
| Separate observation from authority | A technically valid defect is not a remediation target without a basis authorizing its repair in this task |
| Limit authorization bases | Accept only direct acceptance-criterion violations, regressions introduced by the current diff, required consumer migrations, and closure of an accepted contract family |
| Preserve horizontal boundaries | Proximity, general quality, or presence in the same file does not authorize work on a neighboring contract or improvement |
| Minimal internal fix | Accept the defect without expanding its remediation into new external behavior, guarantees, limits, or compatibility routes |
| Round-local adjudication | Return exactly one decision for every submitted `sourceIndex`; do not refer to findings from earlier rounds |

## Decisions

Return `accept` only when the reported defect is supported by current evidence and the task authorizes its remediation. Return `reject` for unsupported, duplicate-within-the-current-list, out-of-scope, preference-only, ordinary-incompleteness, or overreaching findings. When evidence is insufficient, reject rather than guessing.

The reviewer severity is evidence for the implementation agent, not an adjudication gate. Do not change severity, create replacement findings, merge into historical findings, or preserve any cross-round state.

## Complete adjudication

Every submitted finding must have one decision with its original round-local `sourceIndex` and a concise reason. The set of returned indices must match the submitted list exactly, with no duplicate or omitted indices.
