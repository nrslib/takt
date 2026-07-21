A loop containing a post-fix review has repeated {cycle_count} times.

Use the Finding Contract ledger summary / `findings-ledger.json` as the primary evidence and the latest reports in the Report Directory as supporting evidence. Decide in this order:

1. First confirm that this judgment occurs after a post-fix review or final gate. Never classify repetition or stagnation from a completed fix alone.
2. Check whether the post-fix review reconfirms the same `finding_id` or the same `family_tag` problem seen before the latest fix.
3. A different new finding normally indicates progress. Treat it as partial-fix recurrence only when branches of the same recently resolved `family_tag` keep appearing.
4. If redefining the implementation approach, test strategy, or finding treatment under the current requirements and acceptance criteria can resolve the loop, choose replanning.
5. If post-fix evidence makes the next fix concrete and actionable, continue the normal fix path.
6. Choose ABORT only when no feasible approach can satisfy the requirements after the attempted fixes and replans.

**When Findings state is present:**
- Treat `findings` / `conflicts` as authoritative. An open status alone does not prove a failed fix; require evidence reconfirmed after the latest fix.
- A provisional fixpoint or exhausted budget is evidence of stagnation. Choose replan when a requirements-compliant redefinition remains possible, and ABORT only after attempted redefinition still cannot produce a viable approach.
- Do not propose human adjudication, manual ledger edits, or resume as the resolution.
