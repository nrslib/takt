# Review Finding Decisions

Decide separately whether a submitted finding is technically correct and whether the current change must repair it. Select only necessary repairs.

## Decision Criteria

| Situation | Treatment |
|-----------|-----------|
| Direct violation of the original requirement or acceptance criteria | Repair |
| Regression introduced by the current diff or repair | Repair |
| Current consumers must migrate for a changed contract to work | Repair |
| An unvisited consumer has the same cause, condition, and acceptance criteria as a problem already selected for repair | Merge into the same problem and repair |
| A real separate problem whose necessity cannot be derived from the current request or repair | Outside this task |
| No requirement makes the current behavior defective and the finding asks only for a stronger mechanism or guarantee | Unnecessary expansion |
| Current code or evidence contradicts the finding | Unsupported, or no issue after verification |
| A required external environment is unavailable and the implementation claim can be neither confirmed nor disproved | Cannot verify in this environment |

## Principles

- Base decisions on facts confirmed by current code, requirements, reports, or execution evidence
- Do not select a repair solely because of severity, a REJECT label, a suggested fix, or discovery timing
- When a finding combines a real defect with an excessive repair proposal, judge them separately and retain only the minimum necessary repair
- Group findings when their cause, violated observable condition, and acceptance criteria are the same. Keep problems separate when their conditions differ even if they share a responsible location
- For each problem selected for repair, inspect actual paths affected by the same cause from the defining source through consumers to externally observable results
- Do not add atomicity, transactions, rollback, resource limits, compatibility paths, or similar requirements when they are unnecessary to resolve the verified defect
- Do not dismiss an undecidable concern by assumption; record the information needed as an unresolved premise
- Decide every submitted finding ID once and do not omit the remainder after finding the first repair target
