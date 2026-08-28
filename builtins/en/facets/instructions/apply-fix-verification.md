Correct every gap found by the latest completion verification and finish the finalized fix plan.

**Fix plan:**
{report:fix-plan.md}

**Latest completion verification:**
{report:fix-verification.md}

**Previous fix report:**
{report:fix-report.md}

{{include:instructions/quality-gate-causality}}

**Procedure after a verifier return:**
1. Map every verified gap to a completion obligation in the plan
2. Do not split problems with the same cause, condition, and acceptance criteria based only on physical code locations or file paths
3. Determine why the previous evidence missed each gap: an unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated completion report
4. When the observation or detection method itself failed, recheck every obligation closed with the same assumption, search method, or evidence
5. When the same condition repeatedly fails on different paths, do not patch only the reported path. Repair all affected paths at a shared change point or prevent the violation through the type or state structure
6. Correct the verification method, then implement and recheck items previously marked complete under the same premise and every incomplete item in the plan
7. Add or update a failure example that detects the same gap and record its result

Do not treat the locations listed by verification as the upper bound of the repair. Request plan revision only when assumptions, repair boundaries, methods, or evidentiary power are insufficient or inconsistent and a plan change can resolve the deficiency.

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-retry-path-check}}
{{include:instructions/established-invariants-scan}}
{{include:instructions/post-edit-self-scan}}

Record the work result, changes and acceptance criteria, and verification evidence in the requested format.
