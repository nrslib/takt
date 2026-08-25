Independently verify whether the implementation fulfills the fix plan. Do not edit source files or perform a new full review.

**Reports to inspect:**
- Fix plan: {report:fix-plan.md}
- Fix report: {report:fix-report.md}

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-verification-path-check}}
{{include:instructions/quality-gate-causality}}

Inspect independently needed reports, sources of truth, and direct call paths together in the same evidence pass where possible. This sets only the inspection order and is not a reason to broaden the scope. Do not serialize reads or searches that are independent of one another behind progress updates, and do not continue checking for absent optional history or tests that are unnecessary for the decision. Once the required evidence is available, return the output-contract result; do not end the response with progress updates only.

**Verification procedure:**
1. Inspect the latest reviewer reports in the Report Directory to confirm the problems, invariants, acceptance criteria, and boundaries from adjacent problems covered by the plan
2. Do not use the fix report as an answer key. Follow the repair-path verification above and finalize the comparison between the authoritative-source-derived states and paths and the plan
3. Expand the derived set into atomic completion obligations in the form `invariant x affected path x counterexample that breaks it`. Compare behavior correction, consumer migration, obsolete-path removal, and existing-contract preservation separately with the current code and diff
4. For every obligation, trace failure cases, boundaries, and opposite-direction counterexamples as well as success cases from the current code and recorded evidence. Do not stop at the first gap; apply the same detection pattern across every fix unit closed with the same assumption or search method
5. Decide static obligations from code comparison, and compare runtime behavior against the current code and the provided reports, logs, and recorded results. Identify which existing observation point would detect each broken obligation; do not rely only on a broad test-suite pass or the repair report's self-assessment. Mark any unrecorded range as unverified, but do not treat the absence alone as a reason to mark the work incomplete or require another fix
6. Inspect only the quality gates recorded in the repair report. Do not require additional gates that are not recorded there
7. Reconcile the plan and repair report's invariants. Then update and carry them forward according to the output contract
8. Distinguish implementation or evidence gaps from deficiencies in the plan's assumptions, repair boundary, method, or verification capability. Separate an item as environmental follow-up only when the current code and recorded evidence establish that it is not an implementation defect

Follow the output contract for the result classification and required fields. Report success only after independently confirming every completion obligation and acceptance criterion addressable in the current loop. Otherwise list every gap found and explain why the repair report's evidence did not detect it.
