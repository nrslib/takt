{{include:instructions/contract-family-fix-plan}}
{{include:instructions/fix-root-cause-analysis}}
{{include:instructions/fix-plan-validity}}

**Tasks:**
1. Enumerate every remediation target and acceptance criterion, mapping each issue ID or source to exactly one fix unit or follow-up verification without omissions
2. Separate independent local issues, structural issues that share a cause, and items that cannot be demonstrated in the current environment. Exclude an item from implementation remediation as environmental only when the current prompt provides such judgment criteria and every condition is met
3. For each structural issue, derive every invariant, valid example, failing example, and boundary value from the authoritative source, then identify the responsibility and source of truth plus every actual definition, producer, normalizer, validator, consumer, retry, fallback, parallel path, persistence and restoration path, and terminal or API output. Distinguish the family's vertical paths from a neighboring contract
4. Define dependency order and completion criteria without separating boundary or source-of-truth changes, consumer migration, and removal of duplicate or obsolete paths. Do not include follow-up that cannot be demonstrated due to environmental factors in the implementation order
5. Preflight each fix unit's methods and evidence and replace conflicting candidate methods while preserving acceptance criteria. Define tests or reproducible evidence capable of disproving every invariant and the final quality gates. Separate evidence from current completion criteria only when provided applicable criteria classify it as environmental, and define deterministic alternative evidence plus follow-up verification
6. If no compliant method exists under the same requirements and design assumptions, do not finalize the plan; state why task-level replanning is required
