Correct the gaps found by the latest completion verification and finish the finalized fix plan.

**Fix plan:**
{report:fix-plan.md}

**Latest completion verification:**
{report:fix-verification.md}

**Previous fix report:**
{report:fix-report.md}

**Required procedure after a verifier return:**
1. Map every verifier gap to its completion obligation
2. Before editing, consume the recurrence record in the latest completion verification without independently reclassifying it. If its carry-forward or recurrence fields are missing or inconsistent, continue editing but record the artifact deficiency and reason in the fix report; do not treat it as non-recurrence, choose a repair limited to the reported path, or change its count or trigger
3. Classify why the previous evidence could not detect it as an unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated completion report
4. Invalidate that proof method and reopen every obligation, including obligations in other fix units, closed with the same assumption, search method, or evidence
5. When the recorded trigger is true, implement the plan's enforcement point for every recorded `participates` path or consolidate state so violation is impossible at the type or structural level. When the recurrence record has an artifact deficiency, conservatively prefer the plan's shared owner and enforcement direction over a path-local repair. Return `Fix plan requires revision` only when the plan lacks a required stable ID, owner, enforcement boundary, or enforcement point required after an established trigger, or when the structural correction exceeds the remediation boundary
6. Correct the observation point or counterexample, then implement and rerun every reopened obligation and every still-open obligation in the whole plan
7. Add or update a counterexample that detects the recurrence, and record its result

The verifier list contains examples of incomplete coverage; it is not an upper bound on this remediation. Do not correct only the listed locations and resubmit. Request fix-plan revision only for the plan deficiencies or remediation-boundary excess defined above.

{{include:instructions/fix-plan-validity}}
{{include:instructions/invariant-recurrence}}
{{include:instructions/contract-family-fix-retry}}

{{include:instructions/established-invariants-scan}}
{{include:instructions/post-edit-self-scan}}

**Required output (include headings)**
## Work result
- {Fix complete / Fix plan requires revision / Task-level replanning required}
## Changes and acceptance criteria
- {Consumed recurrence record or artifact deficiency, changes by fix unit, and falsification method, evidence, and status for every obligation reopened after the verifier return}
## Verification and evidence
- {Commands and results plus code, diffs, reports, and logs inspected}
