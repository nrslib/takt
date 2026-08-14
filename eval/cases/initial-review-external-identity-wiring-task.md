# Initial review: external step target routing

Review the cumulative implementation of external step target routing.

The change adds a documented external step target key, a workflow fixture, runtime target configuration, execution and preview resolution, and an end-to-end test. A configured external target must be selected in both execution and preview; the default runner is only for steps without an explicit external target. Existing workflow-local cache behavior must remain intact.

Treat this as the initial review. Read the documentation, references, calls, and data flow needed to check whether the change works as documented. Report every confirmed blocking problem and any missing behavior-level regression coverage. Also record the relevant paths that you checked and found correct or unrelated, without requiring changes to a neighboring feature.
