```markdown
# Repair Report

## Summary
{Changes made, acceptance criteria completed, and remaining problems}

## Changes
| Repair Unit | Findings | Changed Paths | Work Performed | Evidence | Status |
|-------------|----------|---------------|----------------|----------|--------|
| {Name from the plan} | {ID list} | {Actual affected paths} | {Boundary change, consumer migration, obsolete-path removal, or local repair} | {Changed locations and observable results} | {Complete / Plan revision needed / Blocker} |

## Completion Obligations
| Repair Unit | Obligation ID | Type | Target Findings | Invariant and Affected Path | Falsification Method or Observation | Pre-edit or Returned Result | Implementation Evidence | Post-edit Evidence | Status |
|-------------|---------------|------|----------------|-----------------------------|--------------------------------------|----------------------------|-------------------------|---------------------|--------|
| {Name from the plan} | {Stable unique obligation ID within the repair unit; retain it across fix and retry} | {Behavior repair / Consumer migration / Obsolete-path removal / Existing-contract preservation} | {Finding IDs} | {One invariant and one actual path} | {Test, reproduction, search, or code trace that fails on violation} | {Pre-edit failure, remaining artifact, or baseline to preserve} | {Changed location or preserved implementation} | {Targeted execution or inspection result} | {Complete / Not applicable / Incomplete / Blocker} |

## Completion Checks
| Repair Unit | Condition | Path or State Checked | Violation-Detection Method | Result | Evidence |
|-------------|-----------|-----------------------|----------------------------|--------|----------|
| {Name from the plan} | {Acceptance criterion or existing condition to preserve} | {Actual path or state} | {Failure example, boundary case, search, or code tracing} | {Satisfied / Violated / Unverified} | {file:line, test, or reproduction result} |

## Evidence Revised After Rejection
| Repair Unit | Previously Missed Gap | Why It Was Missed | Revised Check | Scope Rechecked with the Same Method |
|-------------|-----------------------|------------------|---------------|--------------------------------------|
| {Only when applicable} | {Verified gap} | {Unvisited path, weak observation, incorrect assumption, incomplete migration, or overstated completion} | {Added or revised check} | {Items previously marked complete under the same premise and their results} |

## Quality Gates
| Type | Result | Evidence |
|------|--------|----------|
| {Build / Test / Other} | {Pass / Fail / Not run} | {Command or check performed} |

## Incomplete Items
- {None, or repair unit, condition, reason, and required next action}
```

- Keep paths related to the same problem in the same repair unit
- After rejection, recheck the scope previously marked complete with the same method instead of repairing only the reported location
- Record completion only when every relevant condition holds in current code
