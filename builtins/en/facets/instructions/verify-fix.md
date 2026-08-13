Independently verify whether the implementation fulfills the fix plan. Do not edit source files or perform a new full review.

**Reports to inspect:**
- Fix plan: {report:fix-plan.md}
- Fix report: {report:fix-report.md}

{{include:instructions/fix-plan-validity}}
{{include:instructions/invariant-recurrence}}
{{include:instructions/contract-family-fix-verifier}}

**Verification procedure:**
1. Inspect the latest reviewer reports in the Report Directory to confirm the findings and acceptance criteria covered by the plan
2. Do not use the fix report as an answer key. Independently expand every invariant into atomic completion obligations in the form `invariant x participating path x counterexample that breaks it`. Compare behavior correction, consumer migration, obsolete-path removal, and existing-contract preservation separately with the current code and diff
3. For every completion obligation, execute or trace failure cases, boundaries, and opposite-direction counterexamples as well as success cases. Do not close distinct failures, early exits, retries or resumes, or callers with one passing result. When a gap is found, apply its detection pattern across every fix unit closed with the same assumption, search method, or evidence. Finding one blocker must not stop the sweep; finish checking every obligation
4. Run the targeted tests or reproductions needed for verification, and use observations that would fail when each obligation is broken rather than the fix report's self-assessment or a broad test-suite pass. Also confirm that the tests do not depend on an obsolete path targeted for removal or freeze behavior absent from the source of truth
5. Reconcile the fix report's invariant-register carry-forward with every invariant in the fix plan. If carry-forward fields or rows are missing or inconsistent, rebuild a complete register from the plan, record the artifact deficiency and reason, and continue verification. Treat a missing matching identity as a first occurrence only when no prior row represents the same observable invariant; if a family ID, invariant stable ID, or authoritative owner changed, require the explicit plan change and reason, retain the old row as predecessor history, and otherwise record a plan inconsistency
6. Output one recurrence-record row for every planned invariant. Only for invariants found `incomplete` in this sweep, shift the recorded incomplete occurrence and path, advance the cumulative count at most once, and evaluate the trigger under the shared definition. For every other invariant, preserve the recorded occurrences, paths, count, and trigger unchanged and record that the recurrence state was maintained. When the trigger is true, direct the next fix to close the invariant at the candidate enforcement point rather than block the current path, and state that repeated local repairs will not close it
7. Return `incomplete` only for an implementation or evidence gap that another fix can resolve in the current execution environment. A carry-forward artifact deficiency alone is not `plan_invalid`. Use the shared fix-plan-validity rules as the complete `plan_invalid` decision set
8. When the current prompt provides environmental criteria and an item meets every condition, record it for follow-up if the implementation, deterministic alternative evidence, and execution-path or CI wiring have no gap. Do not return `incomplete` or `plan_invalid` for that reason alone

Return `verified` only after independently confirming every completion obligation and acceptance criterion actionable in the current loop. For `incomplete` or `plan_invalid`, list every gap found in this sweep and why the fix report's evidence failed to detect it so the next fix can address them together. Record follow-up that cannot be demonstrated due to environmental factors without treating it as successful evidence, and do not treat any other unverified item as successful. Do not fail solely because the full quality gate has not run.
