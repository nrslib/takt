```markdown
# Fix Completion Verification

## Result: verified / incomplete / plan_invalid

When a plan omission or other plan defect coexists with an implementation or evidence gap, record every gap of both kinds in the unmet or unverified items — never drop one kind of gap because the other exists. For an item affected by both conditions, record both applicable conditions, their evidence, and the required actions.

## Summary
{Decision and primary evidence}

## Fix Unit Compatibility
| Fix Unit | Target Findings | Cause, Repair Boundary, Assumptions, Methods, and Evidentiary Power | Decision |
|----------|-----------------|---------------------------------------------------------------------|----------|
| {Fix-unit name from the plan} | {IDs} | {Result of comparison with active constraints and current code} | {compatible / plan invalid} |

## Fix Plan State and Path Check
| Fix Unit | Authoritative Source | Applicable Member or State | Actual Path from Entry to Terminal | Comparison with Plan | Decision |
|----------|----------------------|----------------------------|------------------------------------|----------------------|----------|
| {Fix-unit name from the plan} | {Requirement, specification, schema, type, state transition, or current implementation} | {One independently derived member or state; repeat it for each distinct path} | {One complete entry-to-terminal path using actual names and only applicable stages} | {recorded / required path omitted / out-of-scope path included} | {compatible / plan invalid} |

For every applicable member or state, record each distinct entry-to-terminal path as its own row. When no finite set or state dimension applies, record each existing path governed by the same invariant as its own row. Record current implementation as authoritative only where a definition separate from the behavior under repair establishes the applicable set, state transition, or public contract; never use the behavior under repair as its own source of truth. Do not construct unsupported combinations of dimensions.

## Independent Completion Obligation Verification
| Fix Unit | Obligation ID | Target Findings | Invariant and Affected Path | Independently Chosen Counterexample or Observation | Observed Result | Evidence | Decision |
|----------|---------------|-----------------|-----------------------------|----------------------------------------------------|-----------------|----------|----------|
| {Fix-unit name from the plan} | {ID corresponding to the fix report, or an ID added by independent verification} | {IDs} | {One behavior-correction, consumer-migration, obsolete-path-removal, or existing-contract-preservation obligation and its path} | {Method selected without treating the fix report as an answer key} | {holds / violated / unverified} | {Code, diff, targeted test, search} | {complete / incomplete / plan invalid} |

## Unmet or Unverified Items
| Fix Unit | Obligation ID | Type | Evidence | Why the Fix Report Evidence Could Not Detect It | Scope Re-audited with the Same Detection Pattern | Required Action |
|----------|---------------|------|----------|--------------------------------------------------|--------------------------------------------------|-----------------|
| {Affected unit} | {Obligation ID} | {implementation gap / evidence gap / plan constraint violation / other plan defect} | {Observed fact} | {Unscanned path, weak observation, incomplete migration, unexecuted counterexample, or not reported} | {Fix units and obligations checked by applying the same pattern, with results} | {Action for fix or fix-plan} |

## Follow-up That Cannot Be Demonstrated Due to Environmental Factors (Non-blocking)
| Target | Environmental Factor | Why the Repository Cannot Resolve It | Alternative Evidence Verified Now | Follow-up |
|--------|----------------------|--------------------------------------|-----------------------------------|-----------|
| {Acceptance criterion or None} | {Missing OS, capability, or external environment} | {Why repetition in the same environment cannot increase evidence} | {Deterministic tests, static inspection, execution path, or CI wiring} | {What to verify in an environment where it can run} |

## Execution Evidence
| Target | Method | Result | Connection to the Plan, Diff, or Preserved Condition | Treatment |
|--------|--------|--------|------------------------------------------------------|-----------|
| {Acceptance criterion or counterexample} | {Command or inspection method} | {passed / failed / unverified} | {Verified reference path, diff evidence, or baseline comparison} | {How it affects the completion decision} |
```

For `verified`, state "None" under unmet or unverified items. Follow-up that cannot be demonstrated due to environmental factors may remain, but it is neither successful evidence nor a reason for `incomplete` or `plan_invalid`; state "None" when no such follow-up exists. For `incomplete` or `plan_invalid`, do not stop at the first gap: verify every completion obligation and list every item blocking verification.

- Do not stop after the first gap; inspect every fix unit related by the same cause or verification method.
- Keep the result statement consistent with the satisfied, violated, or unverified items and required actions recorded in the tables.
