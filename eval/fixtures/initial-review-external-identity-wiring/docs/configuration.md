# External step targets

External step target keys use the canonical `<workflow>/<step>` form. For the
`execute` step in `sample-flow`, the key is `sample-flow/execute`.

Runtime configuration, API payloads, fixtures, mocks, and tests must preserve
that canonical key through lookup and terminal execution. The default target is
used only when no canonical external target is configured.

Workflow-local caches are a separate contract. They are already scoped to one
workflow instance and therefore use the bare step name as their local key.
