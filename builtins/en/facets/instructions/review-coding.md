Review the code diff.

Procedure:
1. If a Policy Source Path is provided, open it and review the criteria in its `##` sections
2. Review the task intent, plan, diff, and execution evidence
3. Look for implementation bugs, regressions in existing behavior, security risks, and missing tests
4. For additions or changes to IDs, names, metadata, config, environment variables, or output contracts, reconcile each entry point against the original requirement
5. If the diff adds or changes a shared helper, normalizer, builder, or adapter, verify that existing equivalent branches apply the same contract
6. For diffs involving side effects or state changes, trace entry, normal completion, early exit, exception, and cleanup paths
7. Include only issues caused by the current diff that the user should fix
8. For each finding, include location, impact, and fix direction
9. Do not report unsupported speculation, preference-only changes, or unrelated pre-existing issues
