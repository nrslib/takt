Review only whether changed value and behavior contracts propagate from every equivalent entry point and execution mode through final use and persistence.

1. Read the complete Knowledge and compare the producer, normalization and validation, handoff, persistence, and consumer for each entry path.
2. Report a `contract-wiring` raw finding only when the primary fix belongs in value or contract propagation, validation, or persistence.
3. Omit resource lifetime, cleanup, and optional-operation failure isolation from raw findings and Observed Findings. Do not relabel another review family's defect as `contract-wiring`.
4. Report each observed problem as an individual raw finding under the Finding Contract, and leave deduplication to the findings manager and ledger.

**This is review iteration {step_iteration}.**
