Correct the gaps found by the latest completion verification and finish the finalized fix plan.

**Fix plan:**
{report:fix-plan.md}

**Latest completion verification:**
{report:fix-verification.md}

**Previous fix report:**
{report:fix-report.md}

**Required procedure after a verifier return:**
1. Map every verifier gap to its completion obligation
2. Classify why the previous evidence could not detect it as an unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated completion report
3. Invalidate that proof method and reopen every obligation, including obligations in other fix units, closed with the same assumption, search method, or evidence
4. Correct the observation point or counterexample, then implement and rerun every reopened obligation and every still-open obligation in the whole plan

The verifier list contains examples of incomplete coverage; it is not an upper bound on this remediation. Do not correct only the listed locations and resubmit. Request fix-plan revision only when resolution requires changing the plan's assumptions, invariants, remediation boundary, methods, or evidentiary power.

{{include:instructions/fix-plan-validity}}
{{include:instructions/fix-family-completion}}

**Required output (include headings)**
## Work result
- {Fix complete / Fix plan requires revision / Task-level replanning required}
## Changes and acceptance criteria
- {Changes by fix unit and falsification method, evidence, and status for every obligation reopened after the verifier return}
## Verification and evidence
- {Commands and results plus code, diffs, reports, and logs inspected}
