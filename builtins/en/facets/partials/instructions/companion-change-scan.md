{{include:instructions/contract-path-analysis}}

Starting from the supplied baseline SHA, use read-only repository tools to obtain the current worktree diff and compare the changed invariant across equivalent duplication, one-sided updates, unmigrated consumers, obsolete paths, and missing tests. Inspect real files and callers rather than relying on summaries or uninspected context. Do not edit or perform side effects, claim to have verified paths that were not inspected, or request repair for a different invariant or responsible source.

Follow the active policy for reporting scope.
