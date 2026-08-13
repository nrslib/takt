```markdown
# Fix Report
## Summary
{Summary of the work result, changes, and evidence}

## Fix Units
| Fix Unit | Target Findings | Authoritative Contract | Implementation and Participating Paths | Status |
|----------|-----------------|------------------------|----------------------------------------|--------|
| {Stable ID from the plan, or a stable ID assigned by the fixer when there is no plan} | {IDs} | {Responsibility and source of truth} | {Boundary change, every consumer migration, removal, or local fix} | {Complete only after every completion obligation is closed / approach revision / blocker} |

## Invariant Register Carry-forward
| Fix Unit | Family ID | Invariant Stable ID | Authoritative Owner | Current Verifier Occurrence | Previous Verifier Occurrence | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Trigger | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|---------------------|---------------------|-----------------------------|------------------------------|---------------|--------------|--------------------------------------|-------------------------------|---------|-----------------------------|------------------|
| {One row for every invariant in the fix plan; if no fix plan is provided: None} | {Stable family ID} | {Stable invariant ID} | {Owner from the plan} | {Copy unchanged; on initial fix: None; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: None; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: None; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: None; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: not yet evaluated; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: 0; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: false; for a missing later row: indeterminate} | {Copy unchanged; on initial fix: Not applicable; for a missing later row: plan value or indeterminate} | {Copy unchanged; on initial fix: complete; for a missing later row: artifact deficiency with reason} |

## Carry-forward Deficiencies
- {None, or invariant stable ID, missing or inconsistent field, reason, and conservative handling. Do not modify an existing recurrence row to record this}

## Completion Obligations
| Fix Unit | Obligation ID | Type | Target Findings | Invariant and Participating Path | Falsifying Counterexample or Observation | Pre-edit or Returned Result | Implementation Evidence | Post-edit Evidence | Status |
|----------|---------------|------|-----------------|----------------------------------|----------------------------------------|-----------------------------|-------------------------|--------------------|--------|
| {Stable fix-unit ID} | {Stable ID within the fix unit} | {behavior correction / consumer migration / obsolete-path removal / existing-contract preservation} | {IDs} | {One invariant and one path} | {Test, reproduction, search, or code path that fails when this condition is broken} | {Pre-edit failure, usage, remaining artifact, or preservation baseline} | {Changed location or preserved implementation} | {Targeted execution or inspection result} | {complete / not applicable / incomplete} |

## Acceptance Criteria
| Finding ID | Acceptance Criterion | Evidence | Status |
|------------|----------------------|----------|--------|
| {ID} | {Expected behavior} | {Test or reproducible verification result} | {Complete / disputed / blocker} |

## Evidence Corrections After Verifier Return
| Fix Unit | Obligation ID | Gap Observed by Verifier | Why Previous Evidence Could Not Detect It | Corrected Counterexample or Observation | Obligations Reopened and Rechecked from the Same Proof Method |
|----------|---------------|--------------------------|------------------------------------------|-----------------------------------------|-------------------------------------------------------------|
| {When applicable} | {Obligation ID} | {Observed gap} | {Unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or overstated report} | {Added or corrected evidence} | {Obligation IDs, including obligations in other fix units} |

## Established Invariant Diff Scan
- Established invariant scan: {invariant stable ID}={preserved / violated / unverified}, ...

## Quality Gates
| Type | Result | Evidence |
|------|--------|----------|
| {Build / Test / Other} | {Passed / Failed / Not run} | {Command or verification details} |

## Open Obligations
- {None, or obligation ID, reason, and required next action}
```
