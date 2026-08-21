Independently verify whether the implementation fulfills the fix plan. Do not edit source files or perform a new full review.

**Reports to inspect:**
- Fix plan: {report:fix-plan.md}
- Fix report: {report:fix-report.md}

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-verification-path-check}}

**Verification procedure:**
1. Inspect the latest reviewer reports in the Report Directory to confirm the problems and acceptance criteria covered by the plan
2. Do not use the fix report as an answer key. Independently expand every invariant into atomic completion obligations in the form `invariant x affected path x counterexample that breaks it`. Compare behavior correction, consumer migration, obsolete-path removal, and existing-contract preservation separately with the current code and diff
3. For every obligation, execute or trace failure cases, boundaries, and opposite-direction counterexamples as well as success cases. Do not stop at the first gap; apply the same detection pattern across every fix unit closed with the same assumption or search method
4. Run targeted tests or reproductions that would fail when each obligation is broken. Do not rely only on a broad test-suite pass or the repair report's self-assessment
5. Inspect only the quality gates recorded in the repair report. Do not infer or add unrecorded gates from the plan or current prompt
6. Reconcile the plan and repair report's invariants and recurrence records. Reconstruct missing records from the plan and state the reason, then update and carry them forward in the requested format
7. Distinguish implementation or evidence gaps from deficiencies in the plan's assumptions, repair boundary, method, or verification capability. Treat an item as environmental follow-up only when the current prompt provides criteria and every condition is satisfied

Record the result classification and required fields in the requested format. Report success only after independently confirming every completion obligation and acceptance criterion addressable in the current loop. Otherwise list every gap found and explain why the repair report's evidence did not detect it.
