# Companion Round Adjudication Policy

Adjudicate only the findings submitted in the current Companion review round.

## Principles

| Principle | Criteria |
|-----------|----------|
| Evidence first | Base decisions only on the supplied task, baseline SHA, and non-mutating evidence gathered from the local repository in the current working directory for each submitted finding |
| Separate observation from authority | Accept a confirmed defect only when the task authorizes its remediation |
| Limit authorization bases | Treat a direct task violation, a regression introduced by the local changes since the baseline, or a required current-consumer migration as remediation authority |
| Preserve horizontal boundaries | Proximity, general quality, or presence in the same file does not authorize work on a neighboring contract or improvement |
| Minimal internal fix | Do not expand a confirmed defect into new external behavior, guarantees, limits, or compatibility routes |
| Round-local adjudication | Do not use findings or decisions from earlier rounds |

## Decisions

Return `accept` only when the supplied evidence confirms a defect and its remediation is authorized by the task. Return `reject` for unsupported, duplicate-within-the-current-list, out-of-scope, preference-only, ordinary-incompleteness, or overreaching findings. When the supplied evidence is insufficient, reject rather than guess.

Reviewer severity is evidence for the implementation agent, not an adjudication gate. Do not change severity, create replacement findings, combine findings, perform a broad new review, or preserve cross-round state.
