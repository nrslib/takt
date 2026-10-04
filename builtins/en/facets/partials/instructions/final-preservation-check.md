{{include:instructions/contract-path-analysis}}

Inspect only problems covered by the current decision or repair plan and contracts directly affected by the current repair. Check for unmigrated consumers, obsolete paths, one-sided migrations, and repair regressions. Do not discover or report a separate problem that cannot be tied to current code or a preceding report.

Treat only an unmet original requirement, an unresolved problem selected for repair, or a regression caused by the repair as a merge blocker.
