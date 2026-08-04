{{include:instructions/fix-root-cause-analysis}}
{{include:instructions/fix-plan-validity}}

**Tasks:**
1. Enumerate every remediation target and acceptance criterion, mapping each issue ID or source to exactly one fix unit or follow-up verification without omissions
2. Separate independent local issues, structural issues that share a cause, and items that meet every active Policy condition for being undemonstrable due to environmental factors. Plan local issues as direct fixes, group structural issues, and exclude environmentally undemonstrable items from implementation remediation
3. For each structural issue, derive every invariant, valid example, failing example, and boundary value from the authoritative source, then define responsibility and source of truth and the participating entries, types, schemas, validation boundaries, consumers, state, side effects, and failure paths
4. Define dependency order and completion criteria without separating boundary or source-of-truth changes, consumer migration, and removal of duplicate or obsolete paths. Do not include follow-up that cannot be demonstrated due to environmental factors in the implementation order
5. Preflight each fix unit's methods and evidence and replace conflicting candidate methods while preserving acceptance criteria. Define tests or reproducible evidence capable of disproving every invariant and the final quality gates. Separate evidence that meets every active Policy condition for being undemonstrable due to environmental factors from current completion criteria, and define deterministic alternative evidence plus follow-up verification
6. If no compliant method exists under the same requirements and design assumptions, do not finalize the plan; state why task-level replanning is required
