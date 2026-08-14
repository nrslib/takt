Correct the gaps found by the latest completion verification and finish the finalized fix plan.

**Fix plan:**
{report:fix-plan.md}

**Latest completion verification:**
{report:fix-verification.md}

**Previous fix report:**
{report:fix-report.md}

**Required procedure after a verifier return:**
1. Map every verifier gap to its completion obligation
2. Before editing, use the recurrence judgment and the recorded value for whether recurrence on a different path is confirmed without reclassifying them. When a carried value is `confirmed`, keep it `confirmed` even when other fields are deficient. Allow a normal repair with recurrence judgment `cannot determine (first verification)` and recurrence on a different path `not confirmed` only for a first verification whose carry-forward register is complete and has no earlier row for the same invariant. Only when that observed fact cannot be reconstructed and no carried `confirmed` is known, record `cannot determine`; do not infer `not recurrent` or `not confirmed`, choose a repair limited to the reported path, or change a known count or value for whether recurrence on a different path is confirmed. Treat a missing carry-forward register, or evidence of prior repair or verification without a reconstructable row whose family ID, invariant name, and responsible source (the single responsibility and source that defines the invariant and guarantees it holds) match, as `cannot determine` unless a carried `confirmed` is known. Do not use a physical code location or file path as identity, and do not treat a file move or split alone as a different invariant. Continue editing and record any artifact deficiency and reason in the fix report
3. For each verifier gap other than a carry-forward artifact deficiency, classify why the previous evidence could not detect it as an unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated completion report
4. Only when the observation or detection method actually failed, invalidate that proof method and reopen every obligation, including obligations in other fix units, closed with the same assumption, search method, or evidence. Do not invalidate a proof method merely because carry-forward data is missing or inconsistent
5. When the latest completion verification records recurrence on a different path as `confirmed`, implement the plan's enforcement point for every recorded affected path or consolidate state so violation is impossible at the type or structural level. When it records `cannot determine`, use the same cautious treatment and prefer the plan's responsible source and enforcement direction over a path-local repair. Treat this observed fact independently from the plan's `Structural` classification. Return `Fix plan requires revision` only when required plan fields, assumptions, remediation boundary, methods, or evidentiary power are missing or inconsistent and a plan change can resolve the deficiency
6. Correct the observation point or counterexample, then implement and rerun every reopened obligation and every still-open obligation in the whole plan
7. Add or update a counterexample that detects the recurrence, and record its result

The verifier list contains examples of incomplete coverage; it is not an upper bound on this remediation. Do not correct only the listed locations and resubmit. Request fix-plan revision only when required plan fields, assumptions, remediation boundary, methods, or evidentiary power are missing or inconsistent and a plan change can resolve the deficiency.

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
