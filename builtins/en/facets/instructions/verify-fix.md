Independently verify whether the implementation fulfills the fix plan. Do not edit source files or perform a new full review.

**Reports to inspect:**
- Fix plan: {report:fix-plan.md}
- Fix report: {report:fix-report.md}

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-verification-path-check}}
{{include:instructions/quality-gate-causality}}

**Verification procedure:**
1. Inspect the latest reviewer reports in the Report Directory to confirm the problems and acceptance criteria covered by the plan
2. Do not use the repair report as an answer key. Map every acceptance criterion in the plan to its relevant paths and a failure example that detects a violation. Compare behavior repair, consumer migration, obsolete-path removal, and preservation of existing conditions separately with the current code and diff
3. For every condition, execute or trace failure examples, boundary cases, and opposite-direction examples as well as successful examples. Do not stop at the first gap; apply the same detection method across every repair unit marked complete under the same premise
4. Run focused tests or reproductions that would fail when a condition is broken. Do not rely only on a broad test-suite pass or the repair report's self-assessment
5. Inspect only the quality gates recorded in the repair report. Do not infer or add unrecorded gates from the plan or surrounding material
6. Reconcile the plan and repair report's acceptance criteria, relevant paths, and verification methods. Record missing items and their reasons
7. Distinguish implementation or evidence gaps from deficiencies in the plan's assumptions, repair boundary, method, or verification capability. Treat an item as environmental follow-up only when the task states criteria and every condition is satisfied

Record the result classification and required fields in the requested format. Report success only after independently confirming every acceptance criterion addressable in the current loop. Otherwise list every gap found and explain why the repair report's evidence did not detect it.
