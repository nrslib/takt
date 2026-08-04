A loop containing a post-fix review has repeated {cycle_count} times.

Treat the engine-provided live Finding Contract ledger summary / current Finding state as authoritative. A `findings-ledger.json` file, when present, is only an auxiliary snapshot. Use the latest reports in the Report Directory as supporting evidence. Decide in this order:

1. First confirm that this judgment occurs after a post-fix review or final gate. Never classify repetition or stagnation from a completed fix alone.
2. For fix progress, check whether the post-fix review reconfirms the same `finding_id`, root cause, or acceptance criterion.
3. For report convergence, check whether valid new structural or contract findings keep being added across completed review rounds. A different finding or `family_tag` is not itself evidence of progress.
4. The loop may be converging when new findings are limited to a finite set of local issues and the unreviewed structural or contract surface is not expanding. Treat counts as supporting information.
5. If redefining the implementation approach, test strategy, or finding treatment under the current requirements and acceptance criteria can resolve the loop, choose replanning.
6. If post-fix evidence makes the next fix concrete and actionable, continue the normal fix path.
7. Choose ABORT only when no feasible approach can satisfy the requirements after the attempted fixes and replans.

**When engine-provided current Finding state is present:**
- Treat its `findings` / `conflicts` as authoritative. An open status alone does not prove a failed fix; require evidence reconfirmed after the latest fix.
- A provisional fixpoint or exhausted budget is evidence of stagnation. Choose replan when a requirements-compliant redefinition remains possible, and ABORT only after attempted redefinition still cannot produce a viable approach.
- Do not propose human adjudication, manual ledger edits, or resume as the resolution.
