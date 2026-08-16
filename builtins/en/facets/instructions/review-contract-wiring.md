Review only whether changed value and behavior contracts propagate from every equivalent entry point and execution mode through final use and persistence.

{{include:instructions/review-investigation-discipline}}

1. Compare producer, normalization or validation, handoff, persistence, and consumer paths confirmed to exist from definitions and references. Apply relevant supporting material when the current prompt provides it.
2. Report a defect only when the primary fix belongs in value or contract propagation, validation, or persistence.
3. Do not report resource lifetime, cleanup, or optional-operation failure isolation, and do not reclassify a defect from another review scope as part of this one.
