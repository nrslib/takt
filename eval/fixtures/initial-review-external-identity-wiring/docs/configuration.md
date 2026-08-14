# External step targets

External step target keys use the `<workflow>/<step>` form. For the
`execute` step in `sample-flow`, the key is `sample-flow/execute`.

Runtime configuration, API payloads, fixtures, mocks, and tests must preserve
that complete key through lookup and final execution. The default target is
used only when no external target is configured for the step.

Workflow-local caches are a separate contract. They are already scoped to one
workflow instance and therefore use the bare step name as their local key.
