Independently verify whether the implementation fulfills the fix plan. Do not edit source files or perform a new full review.

**Reports to inspect:**
- Fix plan: {report:fix-plan.md}
- Fix report: {report:fix-report.md}

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-verification-path-check}}
{{include:instructions/quality-gate-causality}}

Inspect independently needed reports, sources of truth, and direct call paths together in the same evidence pass where possible. This governs execution order and does not authorize broader exploration. Do not serialize reads or searches that are independent of one another behind progress updates, and do not continue checking for absent optional history or tests that are unnecessary for the decision. Once the required evidence is available, return the output-contract result; do not end the response with progress updates only.

**Verification procedure:**
1. Inspect the latest reviewer reports in the Report Directory to confirm the problems, invariants, acceptance criteria, and boundaries from adjacent problems covered by the plan
2. Do not use the fix report as an answer key. Follow the repair-path verification above and finalize the comparison between the authoritative-source-derived states and paths and the plan
3. Expand the derived set into atomic completion obligations in the form `invariant x affected path x counterexample that breaks it`. Compare behavior correction, consumer migration, obsolete-path removal, and existing-contract preservation separately with the current code and diff
4. For every obligation, execute or trace failure cases, boundaries, and opposite-direction counterexamples as well as success cases. Do not stop at the first gap; apply the same detection pattern across every fix unit closed with the same assumption or search method
5. Do not add execution when code comparison alone establishes a static obligation. Run targeted static analysis when the obligation requires it, and run targeted tests or minimal reproductions only where runtime behavior must be established. When a source trace already proves a violation and more execution cannot change the decision or unresolved items, proceed to the final result without creating a dedicated reproduction environment or temporary copy. Use an observation point that would fail when each obligation is broken; do not rely only on a broad test-suite pass or the repair report's self-assessment. Confirm that the latest fix edit records the required post-edit self-scan for changed imports, exports, callees, and call sites, including matching module-mock/test-double test files and directly owning classified test commands/results; report the verification gap when that evidence is absent
6. Inspect only the quality gates recorded in the repair report. Do not infer or add unrecorded gates from the plan or current prompt
7. Reconcile the plan and repair report's invariants. Then update and carry them forward according to the output contract
8. Distinguish implementation or evidence gaps from deficiencies in the plan's assumptions, repair boundary, method, or verification capability. Treat an item as environmental follow-up only when the current prompt provides criteria and every condition is satisfied

Follow the output contract for the result classification and required fields. Report success only after independently confirming every completion obligation and acceptance criterion addressable in the current loop. Otherwise list every gap found and explain why the repair report's evidence did not detect it.
