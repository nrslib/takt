# Initial review: external identity wiring

Review the cumulative implementation of external step target routing.

The change adds a documented external step identity, a workflow fixture, runtime target configuration, execution and preview resolution, and an end-to-end test. A configured external target must be selected in both execution and preview; the default runner is only for steps without an explicit external target. Existing workflow-local cache behavior must remain intact.

Treat this as the initial review. Determine the changed contract and every participating path from authoritative documentation, actual references, calls, and data flow. Report every confirmed blocking problem, identify missing behavior-level regression coverage, classify examined clean or adjacent paths, and do not require changes to a neighboring contract.
