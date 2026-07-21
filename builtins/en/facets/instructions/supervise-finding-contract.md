Verify evidence for tests, builds, and functional checks, then perform final Finding Contract approval.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool, list every `##` section, and match each criterion against the diff, execution evidence, and reports
2. Split task requirements into the smallest independently verifiable units and verify each against implementing code and current execution evidence
3. Re-evaluate prior raw findings and non-finding concerns, and reconcile shared helpers, normalizers, builders, and adapters with equivalent paths

**Evidence handling:**
- Treat code in the current review snapshot as authoritative for claims about actual code.
- Treat an execution log or report as evidence of current behavior only when its target snapshot matches current code or it was generated after the target change. This condition also applies to `Build Results` and `Test Results`.
- Treat stale reports only as investigation pointers. If they conflict with current code, rerun the check or record it as unverified and use NEED_REPLAN.
- Treat `Verification Evidence` as supporting evidence only when it states the target, check, and result. Mocks, static inspection, and limited unit tests do not prove behavior beyond their scope.
- A record that cannot be found or accessed, or a route that was not fully searched, is unverified. Raise a locationless issue only when the original requirement or existing public contract makes existence or wiring necessary and every required route was searched.

**Output:** Follow the `supervisor-validation-finding-contract` output contract. APPROVE requires zero issues and confirmed required evidence; REJECT requires one or more currently observed defect issues; NEED_REPLAN applies when a major requirement or required evidence is unverified but no issue can be raised. Regardless of the verdict, follow the `supervisor-gate-summary-finding-contract` output contract to accurately summarize the actual verdict, key points, and next action or unfinished reason.
