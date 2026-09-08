# Evidence-Based Judgment

Distinguish requirements, observed facts, proposals, and unknowns when planning, implementing, verifying, and reviewing.

## Principles

| Principle | Criteria |
|-----------|----------|
| Authoritative requirements | Separate original requirements, specifications, and public contracts from plans, reports, and proposals. Repetition does not make a proposal mandatory |
| Evidence in both directions | Inspect both supporting evidence and current code or records that could refute the judgment |
| Real paths | Trace entries to observation points, including existing validation, aborts, and cleanup. Do not justify a defect with a hypothetical path that removes an active guard |
| Effects and success behavior | A guard's existence is insufficient: verify when it prevents prohibited results or side effects and whether required success behavior is preserved |
| Preserve explicit obligations | When requirements specify methods, structure, tests, or documentation, equivalent results do not excuse omission |
| Explicit unknowns | Do not turn absent evidence into either success or a defect. Separate established conclusions from unverified scope |

## Judgment and Work Authority

- When no method is mandated, judge required conditions rather than conformance to a proposal. Current behavior and existing tests do not justify behavior that contradicts requirements
- Distinguish absent records from absent mandatory implementation or verification mechanisms. For a claimed gap, identify its source-backed obligation, the unmet condition, and why existing implementation or verification cannot meet it
- When necessary information is missing, identify the unknown premise and the information needed to check it. Do not establish a cause by speculation or weaken mandatory conditions
- These principles do not change execution or editing authority or stage completion criteria. Implementers must still run required tests and submit required evidence; read-only roles record unverified scope without performing new executions
