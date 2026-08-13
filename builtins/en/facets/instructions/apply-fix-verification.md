Correct the gaps found by the latest completion verification and finish the finalized fix plan.

**Fix plan:**
{report:fix-plan.md}

**Latest completion verification:**
{report:fix-verification.md}

**Previous fix report:**
{report:fix-report.md}

**Required procedure after a verifier return:**
1. Map every verifier gap to its completion obligation
2. Before editing, consume the recurrence record in the latest completion verification without independently reclassifying it, using the shared trigger priority. Preserve a carried true trigger even when other fields are deficient. For a complete first-occurrence record, consume `indeterminate (first occurrence)` with trigger false and allow a normal repair. Only when the trigger itself cannot be reconstructed and no carried true trigger is known, record it as `indeterminate`; do not infer `not recurrent` or `false`, choose a repair limited to the reported path, or change a known count or trigger. Continue editing and record any artifact deficiency and reason in the fix report
3. For each verifier gap other than a carry-forward artifact deficiency, classify why the previous evidence could not detect it as an unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated completion report
4. Only when the observation or detection method actually failed, invalidate that proof method and reopen every obligation, including obligations in other fix units, closed with the same assumption, search method, or evidence. Do not invalidate a proof method merely because carry-forward data is missing or inconsistent
5. When the recorded trigger is true, implement the plan's enforcement point for every recorded `participates` path or consolidate state so violation is impossible at the type or structural level. When the trigger is indeterminate under the shared priority, conservatively prefer the plan's shared owner and enforcement direction over a path-local repair. Return `Fix plan requires revision` only for a plan deficiency under the shared fix-plan-validity rules
6. Correct the observation point or counterexample, then implement and rerun every reopened obligation and every still-open obligation in the whole plan
7. Add or update a counterexample that detects the recurrence, and record its result

The verifier list contains examples of incomplete coverage; it is not an upper bound on this remediation. Do not correct only the listed locations and resubmit. Request fix-plan revision only under the shared fix-plan-validity rules.

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
