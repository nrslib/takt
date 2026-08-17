Review only acquired-resource ownership, ownership transfer, the last consumer, and the release scope.

{{include:instructions/review-investigation-discipline}}

1. Only when the changed contract acquires, transfers, or releases a resource, trace acquisition through release across real success, early-exit, failure, interruption, and retry paths. Apply relevant supporting material when the current prompt provides it.
2. Report a defect only when the primary fix belongs in acquisition, ownership transfer, the `try` / `finally` scope, or release logic.
3. Do not report plain value-wiring gaps or optional-operation failure isolation, and do not reclassify a defect from another review scope as part of this one.
4. For example, omit a defect that replaces a value with an empty array during persistence because it is not a resource-lifetime defect; include a defect where acquisition occurs before the cleanup scope and can therefore escape release.
