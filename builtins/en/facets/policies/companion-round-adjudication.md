# Companion Round Adjudication Policy

Adjudicate only the findings submitted in the current Companion review round.

## Principles

| Principle | Criteria |
|-----------|----------|
| Evidence first | Base decisions only on the supplied task and the cumulative diff snapshot reviewed in this round |
| Separate observation from remediation scope | Accept a confirmed defect only when the task establishes that it requires remediation |
| Limit remediation targets | Remediate only a direct task violation, a regression introduced by the cumulative diff, or a required current-consumer migration |
| Exclude adjacent problems | Proximity, general quality, or presence in the same file does not justify work on a neighboring contract or improvement |
| Minimum necessary fix | Do not expand a confirmed defect into new external behavior, guarantees, limits, or compatibility routes |
| Round-local adjudication | Do not use findings or decisions from earlier rounds |

## Decisions

Return `accept` only when the supplied evidence confirms a defect that the task requires to be remediated. Return `reject` for unsupported, duplicate-within-the-current-list, out-of-scope, preference-only, ordinary-incompleteness, or overreaching findings. When the supplied evidence is insufficient, reject rather than guess.

Reviewer severity is evidence for the implementation agent, not an adjudication gate. Do not change severity, create replacement findings, combine findings, or preserve cross-round state.
