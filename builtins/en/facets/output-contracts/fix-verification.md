```markdown
# Fix Completion Verification

## Result: verified / incomplete / plan_invalid

## Summary
{Decision and primary evidence}

## Fix Unit Verification
| Fix unit | Findings | Constraint Compatibility | Implementation | All invariants | Counterexamples and adjacent paths | Evidence | Decision |
|----------|----------|--------------------------|----------------|----------------|------------------------------------|----------|----------|
| {Stable ID from the plan} | {IDs} | {Verification of methods, evidence, and observation points} | {Observed state} | {Verification result} | {Verification result} | {Code, diff, tests} | {complete / incomplete / plan invalid} |

## Unmet or Unverified Items
| Fix unit | Type | Evidence | Required action |
|----------|------|----------|-----------------|
| {Affected unit} | {implementation gap / evidence gap / plan constraint violation / other plan defect} | {Observed fact} | {Action for fix or fix-plan} |

## Follow-up That Cannot Be Demonstrated Due to Environmental Factors (Non-blocking)
| Target | Environmental Factor | Why the Repository Cannot Resolve It | Alternative Evidence Verified Now | Follow-up |
|--------|----------------------|--------------------------------------|-----------------------------------|-----------|
| {Acceptance criterion or None} | {Missing OS, capability, or external environment} | {Why repeating work in the same environment cannot increase evidence} | {Deterministic tests, static inspection, execution path, or CI wiring} | {What to verify in an environment where it can run} |

## Verification Evidence
| Target | Method | Result |
|--------|--------|--------|
| {Acceptance criterion or counterexample} | {Command or inspection method} | {passed / failed / unverified} |
```

For `verified`, state "None" under unmet or unverified items. Follow-up that cannot be demonstrated due to environmental factors may remain, but it is neither successful evidence nor a reason for `incomplete` or `plan_invalid`; state "None" when no such follow-up exists. For `incomplete` or `plan_invalid`, list every item blocking verification.
