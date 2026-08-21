Correct every gap found by the latest completion verification and finish the finalized fix plan.

**Fix plan:**
{report:fix-plan.md}

**Latest completion verification:**
{report:fix-verification.md}

**Previous fix report:**
{report:fix-report.md}

**Procedure after a verifier return:**
1. Map every verified gap to a completion obligation in the plan
2. Carry recurrence records forward without splitting a problem governed by the same invariant based only on physical code locations or file paths
3. Determine why the previous evidence missed each gap: an unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated completion report
4. When the observation or detection method itself failed, recheck every obligation closed with the same assumption, search method, or evidence
5. When the same invariant repeatedly breaks through different paths, do not repair only the reported path; implement the planned enforcement point across the bounded graph or make violation impossible by type or structure
6. Correct the observation point or counterexample, then implement and rerun obligations that require rechecking and all remaining obligations in the plan
7. Add or update a counterexample that detects recurrence and record its result

Do not treat the locations listed by verification as the upper bound of the repair. Request plan revision only when assumptions, repair boundaries, methods, or evidentiary power are insufficient or inconsistent and a plan change can resolve the deficiency.

{{include:instructions/fix-plan-validity}}
{{include:instructions/repair-retry-path-check}}
{{include:instructions/established-invariants-scan}}
{{include:instructions/post-edit-self-scan}}

Record the work result, changes and acceptance criteria, and verification evidence in the requested format.
