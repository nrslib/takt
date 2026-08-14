```markdown
# Fix Completion Verification

## Result: verified / incomplete / plan_invalid

## Summary
{Decision and primary evidence}

## Invariant Recurrence Record
| Fix Unit | Family ID | Invariant Name | Responsible Source | Current Verification Number | Previous Verification Number | Previous Path | Current Path | Same-Invariant / Recurrence Judgment | Cumulative `incomplete` Count | Recurrence on a Different Path Confirmed? | Enforcement-Point Candidate | Record Integrity |
|----------|-----------|---------------------|---------------------|-----------------------------|--------------------------------|---------------|--------------|--------------------------------------|-------------------------------|---------|-----------------------------|------------------|
| {One row for every invariant in the fix plan} | {Family ID from the plan} | {Invariant name from the plan} | {Responsible source from the plan: the single responsibility and source that defines the invariant and guarantees it holds} | {Current verification number when currently incomplete; otherwise carry unchanged} | {Number of the preceding incomplete verification when currently incomplete; otherwise carry unchanged} | {Complete affected-path set from the preceding incomplete verification when currently incomplete; otherwise carry unchanged} | {Complete current violating-path set when currently incomplete; otherwise carry unchanged} | {same / different / recurrent / not recurrent / maintained / cannot determine / cannot determine (first verification); `different` requires the current set to contain a path absent from the preceding incomplete set, and removals alone do not qualify} | {Increment at most once only when currently incomplete; otherwise carry unchanged; use cannot determine with reason when history cannot be reconstructed} | {Keep a carried `confirmed` even when other fields are deficient. Otherwise, with a complete record, use `confirmed` when the same invariant has broken on different paths at least twice and `not confirmed` for a complete first verification; use `cannot determine` only when the value cannot be reconstructed and no carried `confirmed` is known. A recorded `confirmed` may become `not confirmed` only after an explicit plan change whose reason is recorded} | {Required when recurrence on a different path is confirmed; otherwise carry unchanged, Not applicable, or the cautious response when it cannot be determined} | {complete / artifact deficiency / plan deficiency, with reason} |

## Fix Unit Compatibility
| Fix Unit | Target Findings | Compatibility of Assumptions, Methods, and Evidentiary Power | Decision |
|----------|-----------------|--------------------------------------------------------------|----------|
| {Fix-unit name from the plan} | {IDs} | {Result of comparison with active constraints and current code} | {compatible / plan invalid} |

## Independent Completion Obligation Verification
| Fix Unit | Obligation ID | Target Findings | Invariant and Affected Path | Independently Chosen Counterexample or Observation | Observed Result | Evidence | Decision |
|----------|---------------|-----------------|----------------------------------|----------------------------------------------------|-----------------|----------|----------|
| {Fix-unit name from the plan} | {ID corresponding to the fix report, or an ID added by independent verification} | {IDs} | {One behavior-correction, consumer-migration, obsolete-path-removal, or existing-contract-preservation obligation and its path} | {Method selected without treating the fix report as an answer key} | {holds / violated / unverified} | {Code, diff, targeted test, search} | {complete / incomplete / plan invalid} |

## Unmet or Unverified Items
| Fix Unit | Obligation ID | Type | Evidence | Why the Fix Report Evidence Could Not Detect It | Scope Re-audited with the Same Detection Pattern | Required Action |
|----------|---------------|------|----------|------------------------------------------------|--------------------------------------------------|-----------------|
| {Affected unit} | {Obligation ID} | {implementation gap / evidence gap / plan constraint violation / other plan defect} | {Observed fact} | {Unscanned path, weak observation, false assumption, incomplete migration, unexecuted counterexample, or not reported} | {Fix units and obligations checked by applying the same pattern, with results} | {Action for fix or fix-plan} |

## Follow-up That Cannot Be Demonstrated Due to Environmental Factors (Non-blocking)
| Target | Environmental Factor | Why the Repository Cannot Resolve It | Alternative Evidence Verified Now | Follow-up |
|--------|----------------------|--------------------------------------|-----------------------------------|-----------|
| {Acceptance criterion or None} | {Missing OS, capability, or external environment} | {Why repeating work in the same environment cannot increase evidence} | {Deterministic tests, static inspection, execution path, or CI wiring} | {What to verify in an environment where it can run} |

## Verification Evidence
| Target | Method | Result |
|--------|--------|--------|
| {Acceptance criterion or counterexample} | {Command or inspection method} | {passed / failed / unverified} |
```

For `verified`, state "None" under unmet or unverified items. Follow-up that cannot be demonstrated due to environmental factors may remain, but it is neither successful evidence nor a reason for `incomplete` or `plan_invalid`; state "None" when no such follow-up exists. For `incomplete` or `plan_invalid`, do not stop at the first gap: verify every completion obligation and list every item blocking verification.
