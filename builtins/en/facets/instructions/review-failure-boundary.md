Review only required-versus-optional failure boundaries, continuation decisions, and partial-result visibility.

1. Read the complete Knowledge, establish the success path first, then compare how each failure reaches the primary result, caller, and user.
2. Report a `failure-boundary` raw finding only when the primary fix belongs in `catch` / `throw`, failure classification, aggregation, continuation or termination, or partial-result representation.
3. Omit plain value wiring and resource-release placement from raw findings and Observed Findings. Do not relabel another review family's defect as `failure-boundary`.
4. For example, omit a defect that drops a value during persistence because it is not a failure-boundary defect; include a defect where an optional operation's exception fails the primary result.
5. Report each observed problem as an individual raw finding under the Finding Contract, and leave deduplication to the findings manager and ledger.

**This is review iteration {step_iteration}.**
