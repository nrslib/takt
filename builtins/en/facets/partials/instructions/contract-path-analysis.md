**Shared contract-path analysis**

Treat paths as one problem when they share the same observable invariant, the same responsible source that guarantees it, and the same reason to change from one cause. Keep them together even when code locations, file paths, symptoms, users, external boundaries, or terminal consequences differ. Treat them as separate problems only when one of those three properties differs.

Describe real paths as `owner / definition -> producer -> transform / normalize / validate -> persist / transfer / restore -> consumer -> exception / retry / fallback / parallel -> terminal / API / observability`, omitting stages that do not apply.

For every inspected path, state in plain language whether it helps establish the invariant and needs change, connects to the invariant but must retain its established contract, or belongs to a different invariant or responsible source.

This analysis does not itself authorize discovery, reporting, editing, adjudication, or completion. Follow the current instruction and policy for scope and authority.
