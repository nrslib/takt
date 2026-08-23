```markdown
# Repair Completion Verification

## Result
{State briefly whether the planned repair is complete, implementation or evidence remains insufficient, or the plan needs revision}

## Summary
{Decision and key evidence}

## Plan Consistency
| Repair Unit | Findings | Cause, Repair Boundary, and Verification Method | Decision |
|-------------|----------|--------------------------------------------------|----------|
| {Name from the plan} | {ID list} | {Result of checking current code and applicable constraints} | {Whether the plan remains valid or needs revision} |

## Independent Completion Checks
| Repair Unit | Condition | Path or State Checked | Independently Chosen Method | Observation | Evidence | Decision |
|-------------|-----------|-----------------------|-----------------------------|-------------|----------|----------|
| {Name from the plan} | {Acceptance criterion, consumer migration, obsolete-path removal, or preservation of an existing condition} | {Actual path or state} | {Failure example, boundary case, search, or code tracing selected without treating the repair report as ground truth} | {Observed fact} | {Code, diff, focused test, or reproduction result} | {Whether the condition was verified or implementation, evidence, or plan revision remains necessary} |

## Violated or Unverified Items
| Repair Unit | Kind | Evidence | Why the Earlier Check Missed It | Scope Rechecked with the Same Method | Required Action |
|-------------|------|----------|---------------------------------|--------------------------------------|-----------------|
| {Affected unit} | {What remains insufficient} | {Observed fact} | {Unvisited path, weak observation, incorrect assumption, incomplete migration, or missing report} | {Items marked complete under the same premise and their results} | {Repair or plan revision work} |

## Follow-up That Cannot Be Demonstrated in This Environment
| Subject | Environmental Limitation | Why the Repository Cannot Resolve It | Alternative Evidence Checked | Follow-up |
|---------|--------------------------|--------------------------------------|------------------------------|-----------|
| {Acceptance criterion or none} | {Missing OS, capability, or external environment} | {Why repetition in the same environment adds no evidence} | {Static check, focused test, or execution path} | {Check to perform where execution is possible} |

## Execution Evidence
| Subject | Method | Result | Connection to the Plan, Diff, or Preserved Condition | Treatment |
|---------|--------|--------|------------------------------------------------------|-----------|
| {Acceptance criterion or failure example} | {Command or check} | {Observed result} | {Verified reference path, diff evidence, or baseline comparison} | {How it affects the completion decision} |
```

- Do not stop after the first gap; inspect every repair unit related by the same cause or verification method
- Keep the result statement consistent with the satisfied, violated, or unverified items and required actions recorded in the tables
- When only an environmental follow-up remains, record why that limitation cannot be resolved within the repository
