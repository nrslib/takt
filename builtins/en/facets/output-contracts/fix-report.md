```markdown
# Repair Report

## Summary
{Changes made, acceptance criteria completed, and remaining problems}

## Changes
| Repair Unit | Findings | Changed Paths | Work Performed | Evidence | Status |
|-------------|----------|---------------|----------------|----------|--------|
| {Name from the plan} | {ID list} | {Actual affected paths; mark unchanged paths as confirmation-only} | {Boundary change, consumer migration, obsolete-path removal, local repair, or confirmation-only} | {Changed locations and observable results, or why no change is needed} | {Complete / Plan revision needed / Blocker} |

## Completion Checks
| Repair Unit | Condition | Path or State Checked | Violation-Detection Method | Result | Evidence |
|-------------|-----------|-----------------------|----------------------------|--------|----------|
| {Name from the plan} | {Acceptance criterion or existing condition to preserve} | {Actual path or state} | {Failure example, boundary case, search, or code tracing} | {Satisfied / Violated / Unverified} | {file:line, test, or reproduction result} |

## Evidence Revised After Rejection
| Repair Unit | Reported Gap | Reassessment with Evidence and Counterevidence | Required Repair or Basis for Confirmation Only | Scope Rechecked with the Same Method |
|-------------|-----------------------|-------------------|---------------|--------------------------------------|
| {Only when applicable} | {Claim linked to the prior finding} | {Whether the gap exists after comparison with authoritative sources, current guards, and observation points} | {Repair and verification of a real gap, or evidence refuting the premise} | {Items previously marked complete under the same premise and their results} |

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
