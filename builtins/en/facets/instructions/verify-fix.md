Independently verify whether the implementation fulfills the fix plan. Do not edit source files or perform a new full review.

**Reports to inspect:**
- Fix plan: {report:fix-plan.md}
- Fix report: {report:fix-report.md}

{{include:instructions/fix-plan-validity}}

**Verification procedure:**
1. Inspect the latest reviewer reports in the Report Directory to confirm the findings and acceptance criteria covered by the plan
2. Expand every fix unit, invariant, migration, and removal target into a verification table, then compare them with the current code and diff
3. For each fix unit, check success cases, failure cases and boundaries, opposite-direction counterexamples, adjacent branches, and the same defect family
4. Run the targeted tests or reproductions needed for verification, and use observed results rather than the fix report's self-assessment as evidence
5. Return `incomplete` only for an implementation or execution-evidence gap that another fix can resolve in the current execution environment. Return `plan_invalid` only when the plan's assumptions, invariants, remediation boundary, methods, or evidentiary power are insufficient or conflict with its constraints and a fix-plan change can resolve the problem
6. When an item meets every active Policy condition for being undemonstrable due to environmental factors, record it for follow-up if the implementation, deterministic alternative evidence, and execution-path or CI wiring have no gap. Do not return `incomplete` or `plan_invalid` for that reason alone

Return `verified` only after independently confirming every fix unit and acceptance criterion actionable in the current loop. Record follow-up that cannot be demonstrated due to environmental factors without treating it as successful evidence, and do not treat any other unverified item as successful. Do not fail solely because the full quality gate has not run.
