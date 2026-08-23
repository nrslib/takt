**Shared contract-path analysis**

Treat paths as one problem when they share the same observable invariant, the same responsible source that guarantees it, and the same reason to change from one cause. Keep them together even when code locations, file paths, symptoms, users, external boundaries, or terminal consequences differ. Treat them as separate problems only when one of those three properties differs.

Describe real paths as `owner / definition -> producer -> transform / normalize / validate -> persist / transfer / restore -> consumer -> exception / retry / fallback / parallel -> terminal / API / observability`, omitting stages that do not apply.

Do not use a list of file or function names as path evidence. Verify in code the calls, arguments, return values, and storage or restoration that connect an entry point to each consumer. Distinguish candidates whose connection cannot be confirmed as unverified or out of scope.

For every inspected path, state in plain language whether it helps establish the invariant and needs change, connects to the invariant but must retain its established contract, or belongs to a different invariant or responsible source.

Do not expand the review scope merely because this analysis exposes another path. Limit exploration, findings, and edits to work whose necessity follows from the current request and presented review scope.
