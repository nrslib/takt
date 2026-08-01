Create an executable plan that turns every reviewer finding into one coherent fix rather than a series of local patches.

**Important:** Do not edit source files in this step. Inspect the Report Directory recursively and use it with the current code as primary evidence, not the Previous Response.

**Reference policy:**
- When a parseable Finding Contract ledger exists, its open findings are the authoritative target; use individual reports as evidence for causes, reproduction conditions, and acceptance criteria
- When there is no ledger and the current review resolution is explicitly included in this instruction, use its actionable findings as authoritative; do not compare timestamps across report files or add targets from old history
- When neither a ledger nor an explicit current review resolution exists, use the latest reviewer reports in the Report Directory as the authoritative target
- Use individual reviewer and final-gate reports only as evidence for causes, reproduction conditions, and acceptance criteria of findings in the authoritative target; do not independently reopen findings that the target classifies as non-actionable
- Only for persists / reopened findings or a new structural issue reported after a fix, inspect up to two timestamped predecessors per report and identify the assumption missing from the earlier remediation

{{include:instructions/fix-root-cause-analysis}}
{{include:instructions/fix-plan-validity}}

**Tasks:**
1. Enumerate every open finding and acceptance criterion, mapping each finding ID or source to exactly one fix unit or follow-up verification without omissions
2. Separate independent local issues, structural issues that share a cause, and items that meet every active Policy condition for being undemonstrable due to environmental factors. Plan local issues as direct fixes, group structural issues, and exclude environmentally undemonstrable items from implementation remediation
3. For each structural issue, derive every invariant, valid example, failing example, and boundary value from the authoritative contract, then define responsibility and source of truth and the participating entries, types, schemas, validation boundaries, consumers, state, side effects, and failure paths
4. Define dependency order and completion criteria without separating boundary or source-of-truth changes, consumer migration, and removal of duplicate or obsolete paths. Do not include follow-up that cannot be demonstrated due to environmental factors in the implementation order
5. Preflight each fix unit's methods and evidence and replace conflicting candidate methods while preserving acceptance criteria. Define tests or reproducible evidence capable of disproving every invariant and the final quality gates. Separate evidence that meets every active Policy condition for being undemonstrable due to environmental factors from current completion criteria, and define deterministic alternative evidence plus follow-up verification
6. If no compliant method exists under the same requirements and design assumptions, do not finalize the plan; state why task-level replanning is required
