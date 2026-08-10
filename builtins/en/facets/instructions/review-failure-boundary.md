Review only required-versus-optional failure boundaries, continuation decisions, and partial-result visibility.

{{include:instructions/review-investigation-discipline}}

1. Only when the changed contract has failure behavior, compare how real success and failure paths propagate to the primary result, caller, and user. Apply relevant supporting material when the current prompt provides it.
2. Report a `failure-boundary` raw finding only when the primary fix belongs in `catch` / `throw`, failure classification, aggregation, continuation or termination, or partial-result representation.
3. Omit plain value wiring and resource-release placement from raw findings and Observed Findings. Do not relabel another review family's defect as `failure-boundary`.
4. For example, omit a defect that drops a value during persistence because it is not a failure-boundary defect; include a defect where an optional operation's exception fails the primary result.
5. Report each observed problem as an individual raw finding under the Finding Contract, and leave deduplication to the findings manager and ledger.

**This is review iteration {step_iteration}.**
