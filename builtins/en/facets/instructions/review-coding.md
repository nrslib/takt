Review the code diff.

Procedure:
1. If a Policy Source Path is provided, open it and review the criteria in its `##` sections
2. Review the task intent, plan, diff, and execution evidence
3. Look for implementation bugs, regressions in existing behavior, security risks, and missing tests
4. For additions or changes to IDs, names, metadata, config, environment variables, or output contracts, reconcile each entry point against the original requirement
   - For meaningful fields such as `source`, trace, and issue/PR numbers, trace not only the storage shape but also downstream meaning, classification, display, and reuse
   - Even if behavior matches an existing implementation, treat it as in scope when a new public entry, adapter, or tool exposes that contract
5. If the diff adds or changes a shared helper, normalizer, builder, or adapter, verify that existing equivalent branches apply the same contract
6. If types, schemas, validators, or resolvers changed, verify that the corresponding contracts are updated in the same change
7. For values resolved or composed across multiple layers, trace the path from the real entry point through validation, not only standalone normalization
8. Verify that values normalized or validated at a boundary are passed to persistence, execution, and external calls under the same contract; trace whether later code reuses the pre-normalized value
9. If a non-execution entry displays, validates, or explains the same value, compare whether it resolves through the same normalized input, override order, and resolver as the primary execution path
10. When tests exist, verify that they cover the original requirement's branch conditions such as unset, set, invalid value, override, inherited, non-inherited, and unsupported target, not only value presence
11. For diffs involving side effects or state changes, trace entry, normal completion, early exit, exception, interruption, and cleanup paths
12. Include only issues caused by the current diff that the user should fix
13. For each finding, include location, impact, and fix direction
14. If the prose mentions a concern, either put it in the finding table or record it as a non-finding with classification and evidence
15. Do not report unsupported speculation, preference-only changes, or unrelated pre-existing issues
