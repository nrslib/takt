Review only whether changed value and behavior contracts propagate from every equivalent entry point and execution mode through final use and persistence.

{{include:instructions/review-investigation-discipline}}

1. Compare producer, normalization or validation, handoff, persistence, and consumer paths confirmed to exist from definitions and references. Apply relevant supporting material when the current prompt provides it.
2. Report a `contract-wiring` raw finding only when the primary fix belongs in value or contract propagation, validation, or persistence.
3. Omit resource lifetime, cleanup, and optional-operation failure isolation from raw findings and Observed Findings. Do not relabel another review family's defect as `contract-wiring`.
4. Report each observed problem separately with its ID, severity, location, evidence, and proposed fix.

**This is review iteration {step_iteration}.**
