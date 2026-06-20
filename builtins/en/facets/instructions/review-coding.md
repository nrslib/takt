Review the code diff.

Procedure:
1. If a Policy Source Path is provided, open it and review the criteria in its `##` sections
2. Review the task intent, plan, diff, and execution evidence
3. Look for implementation bugs, regressions in existing behavior, security risks, and missing tests
4. For additions or changes to IDs, names, metadata, config, environment variables, or output contracts, reconcile each entry point against the original requirement
5. If the diff adds or changes a shared helper, normalizer, builder, or adapter, verify that existing equivalent branches apply the same contract
6. If types, schemas, validators, or resolvers changed, verify that the corresponding contracts are updated in the same change
7. For values resolved or composed across multiple layers, trace the path from the real entry point through validation, not only standalone normalization
8. If a non-execution entry displays, validates, or explains the same value, compare whether it resolves through the same normalized input, override order, and resolver as the primary execution path
9. When tests exist, verify that they cover the original requirement's branch conditions such as unset, set, invalid value, override, inherited, non-inherited, and unsupported target, not only value presence
10. For diffs involving side effects or state changes, trace entry, normal completion, early exit, exception, and cleanup paths
11. Include only issues caused by the current diff that the user should fix
12. For each finding, include location, impact, and fix direction
13. Do not report unsupported speculation, preference-only changes, or unrelated pre-existing issues
