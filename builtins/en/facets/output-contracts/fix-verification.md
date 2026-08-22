```markdown
# Repair Completion Verification

## Result: verified / incomplete / plan_invalid

## Summary
{Decision and key evidence}

## Plan Consistency
| Repair Unit | Findings | Cause, Repair Boundary, and Verification Method | Decision |
|-------------|----------|--------------------------------------------------|----------|
| {Name from the plan} | {ID list} | {Result of checking current code and applicable constraints} | {Valid / Plan defect} |

## Independent Completion Checks
| Repair Unit | Condition | Path or State Checked | Independently Chosen Method | Observation | Evidence | Decision |
|-------------|-----------|-----------------------|-----------------------------|-------------|----------|----------|
| {Name from the plan} | {Acceptance criterion, consumer migration, obsolete-path removal, or preservation of an existing condition} | {Actual path or state} | {Failure example, boundary case, search, or code tracing selected without treating the repair report as ground truth} | {Satisfied / Violated / Unverified} | {Code, diff, focused test, or reproduction result} | {Complete / Incomplete / Plan defect} |

## Violated or Unverified Items
| Repair Unit | Kind | Evidence | Why the Earlier Check Missed It | Scope Rechecked with the Same Method | Required Action |
|-------------|------|----------|---------------------------------|--------------------------------------|-----------------|
| {Affected unit} | {Implementation gap / Evidence gap / Plan defect} | {Observed fact} | {Unvisited path, weak observation, incorrect assumption, incomplete migration, or missing report} | {Items marked complete under the same premise and their results} | {Repair or plan revision work} |

## Follow-up That Cannot Be Demonstrated in This Environment
| Subject | Environmental Limitation | Why the Repository Cannot Resolve It | Alternative Evidence Checked | Follow-up |
|---------|--------------------------|--------------------------------------|------------------------------|-----------|
| {Acceptance criterion or none} | {Missing OS, capability, or external environment} | {Why repetition in the same environment adds no evidence} | {Static check, focused test, or execution path} | {Check to perform where execution is possible} |

## Execution Evidence
| Subject | Method | Result |
|---------|--------|--------|
| {Acceptance criterion or failure example} | {Command or check} | {Pass / Fail / Unverified} |
```

- Do not stop after the first gap; inspect every repair unit related by the same cause or verification method
- Select `verified` only when no violated or unverified item remains and every planned condition holds
- When only an environmental follow-up remains, record why that limitation cannot be resolved within the repository
