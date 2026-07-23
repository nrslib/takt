Review only acquired-resource ownership, ownership transfer, the last consumer, and the release scope.

1. Read the complete Knowledge and trace acquisition through release on success, early exit, failure, interruption, and retry paths.
2. Report a `resource-ownership` raw finding only when the primary fix belongs in acquisition, ownership transfer, the `try` / `finally` scope, or release logic.
3. Omit plain value-wiring gaps and optional-operation failure isolation from raw findings and Observed Findings. Do not relabel another review family's defect as `resource-ownership`.
4. For example, omit a defect that replaces a value with an empty array during persistence because it is not a resource-lifetime defect; include a defect where acquisition occurs before the cleanup scope and can therefore escape release.
5. Report each observed problem as an individual raw finding under the Finding Contract, and leave deduplication to the findings manager and ledger.

**This is review iteration {step_iteration}.**
