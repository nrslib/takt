{{include:instructions/contract-path-analysis}}

Starting from the supplied baseline SHA, use the available tools only for non-mutating inspection of the repository already present in the current working directory. Obtain its status and diff, then compare the changed invariant across equivalent duplication, one-sided updates, unmigrated consumers, obsolete paths, and missing tests. Inspect real files and callers rather than relying on summaries or uninspected context. Use only that repository; do not create another working copy, change branches, edit, perform side effects, claim to have verified paths that were not inspected, or request repair for a different invariant or responsible source.

Follow the active policy for reporting scope.
