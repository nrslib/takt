```markdown
# Fix Report
## Summary
{Summary of the work result, changes, and evidence}

## Fix Units
| Fix Unit | Target Findings | Contract to Preserve | Implementation and Affected Paths | Status |
|----------|-----------------|------------------------|----------------------------------------|--------|
| {Fix-unit name from the plan, which must not change once chosen, or a name assigned by the fixer when there is no plan} | {IDs} | {Responsibility and source of truth} | {Boundary change, every consumer migration, removal, or local fix} | {Complete only after every completion obligation is closed / approach revision / blocker} |

## Invariant Register Carry-forward
Carry-forward source: {Copy the fix plan's statement unchanged}

| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|---------------------|---------------------|-----------------------------|------------------------------|---------------|--------------|--------------------------------------|-------------------------------|---------|-----------------------------|------------------|
| {One row for every invariant in the fix plan; if no fix plan is provided: None} | {Family ID} | {Invariant name} | {Responsible source from the plan: the single responsibility and source that defines the invariant and guarantees it holds} | {Copy unchanged; on an initial fix with no carried row: None; for a missing later row: cannot determine} | {Copy unchanged; on an initial fix with no carried row: None; for a missing later row: cannot determine} | {Copy unchanged; on an initial fix with no carried row: None; for a missing later row: cannot determine} | {Copy unchanged; on an initial fix with no carried row: None; for a missing later row: cannot determine} | {Copy unchanged; on an initial fix with no carried row: not yet evaluated; for a missing later row: cannot determine} | {Copy unchanged; on an initial fix with no carried row: 0; for a missing later row: cannot determine} | {Copy a known carried `confirmed` unchanged; on a complete initial row with no carried row: `not confirmed`; only when no carried `confirmed` is known and the value cannot be reconstructed: `cannot determine`} | {Copy unchanged; on an initial fix with no carried row: Not applicable; for a missing later row: plan value or cannot determine} | {Copy unchanged; on an initial fix with no carried row: complete; artifact deficiency with reason for a missing later row; plan deficiency with reason for missing or inconsistent plan metadata} |

Apply the initial values of no verification number, cumulative `incomplete` count `0`, and recurrence on a different path `not confirmed` only when the carry-forward information is complete and the invariant has no carried row in the fix plan. An absent source permits initial values only when No prior remediation is recorded and no earlier fix-verification exists in the same remediation. Copy Carry-forward source missing and its reason unchanged, also record it under Carry-forward Deficiencies, and never convert it to initial values. Copy all 13 fields of a carried row unchanged.

When the plan adds a finding path that was merged into an existing family, do not change the register row. Record the repair and evidence for that path under Completion Obligations for the same fix unit.

## Carry-forward Deficiencies
- {None, or invariant name, missing or inconsistent field, reason, and conservative handling. Do not modify an existing recurrence row to record this}

## Completion Obligations
| Fix Unit | Obligation ID | Type | Target Findings | Invariant and Affected Path | Falsifying Counterexample or Observation | Pre-edit or Returned Result | Implementation Evidence | Post-edit Evidence | Status |
|----------|---------------|------|-----------------|----------------------------------|----------------------------------------|-----------------------------|-------------------------|--------------------|--------|
| {Fix-unit name, which must not change once chosen} | {Obligation ID, which must not change once chosen within the fix unit} | {behavior correction / consumer migration / obsolete-path removal / existing-contract preservation} | {IDs} | {One invariant and one path} | {Test, reproduction, search, or code path that fails when this condition is broken} | {Pre-edit failure, usage, remaining artifact, or preservation baseline} | {Changed location or preserved implementation} | {Targeted execution or inspection result} | {complete / not applicable / incomplete} |

## Acceptance Criteria
| Finding ID | Acceptance Criterion | Evidence | Status |
|------------|----------------------|----------|--------|
| {ID} | {Expected behavior} | {Test or reproducible verification result} | {Complete / disputed / blocker} |

## Evidence Corrections After Verifier Return
| Fix Unit | Obligation ID | Gap Observed by Verifier | Why Previous Evidence Could Not Detect It | Corrected Counterexample or Observation | Obligations Reopened and Rechecked from the Same Proof Method |
|----------|---------------|--------------------------|------------------------------------------|-----------------------------------------|-------------------------------------------------------------|
| {When applicable} | {Obligation ID} | {Observed gap} | {Unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated report} | {Added or corrected evidence} | {Obligation IDs, including obligations in other fix units} |

## Established Invariant Diff Scan
| Family ID | Invariant Name | Responsible Source | Status | Evidence | Reason and Follow-up |
|-----------|----------------|--------------------|--------|----------|----------------------|
| {Every distinct family ID, invariant name, and responsible source from the recorded bounded list, exactly once} | {Invariant name} | {The single responsibility and source that defines the invariant and guarantees it holds} | {preserved / violated / unverified} | {Result against the responsible source and recorded bounded graph, with inspected path coverage from the counterexample set or exhaustive scan} | {None, or mandatory reason and follow-up for violated / unverified} |

## Quality Gates
| Type | Result | Evidence |
|------|--------|----------|
| {Build / Test / Other} | {Passed / Failed / Not run} | {Command or verification details} |

## Open Obligations
- {None, or obligation ID, reason, and required next action}
```
