Review the code diff.

Procedure:
1. Review the task intent, plan, diff, and execution evidence
2. Look for implementation bugs, regressions in existing behavior, security risks, and missing tests
3. If the diff adds or changes a shared helper, normalizer, builder, or adapter, verify that existing equivalent branches apply the same contract
4. For diffs involving side effects or state changes, trace entry, normal completion, early exit, exception, and cleanup paths
5. Include only issues caused by the current diff that the user should fix
6. For each finding, include location, impact, and fix direction
7. Do not report unsupported speculation, preference-only changes, or unrelated pre-existing issues
