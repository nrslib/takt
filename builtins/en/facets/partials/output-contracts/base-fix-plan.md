```markdown
# Repair Plan

## Result: FIX PLAN CONFIRMED / REPLAN REQUIRED

## Findings and Repair Units
| Finding ID / Source | Repair Unit | Evidence | Acceptance Criteria |
|---------------------|-------------|----------|---------------------|
| {ID and report name} | {Name for repairs sharing the same cause and completion criteria} | {Report or file:line} | {Observable completion conditions} |

## Repair Units
| Repair Unit | Cause | Condition to Preserve | Relevant Paths | Changes | Excluded Scope |
|-------------|-------|-----------------------|----------------|---------|----------------|
| {Name} | {Verified cause and primary alternatives ruled out} | {Externally observable condition} | {Actual paths from the defining source through consumers to output} | {Minimum necessary changes} | {Separate contracts, adjacent work, and unnecessary mechanism changes} |

## Implementation Order
| Order | Repair Unit | Work | Dependency | Completion Criteria |
|-------|-------------|------|------------|---------------------|
| {N} | {Name} | {Boundary change / Consumer migration / Obsolete-path removal / Local repair} | {Earlier work or none} | {Condition verifiable from code and observable results} |

## Verification Approach
| Repair Unit | Path or State to Check | Successful Example | Failure or Boundary Example | Method |
|-------------|------------------------|--------------------|-----------------------------|--------|
| {Name} | {Actual affected path or state} | {Concrete expected success} | {Concrete example that detects a violation} | {Test, reproduction, search, or code tracing} |

## Replanning Items
- {None, or evidence that the cause, requirement, or repair boundary cannot be established and the decision needed}
```

- Combine findings into one repair unit when they share the same cause, condition to preserve, and acceptance criteria
- While planning each repair unit, inspect actual paths affected by the same cause instead of only the reported location
- Do not add nonexistent paths or unrelated mechanisms as checklist items
- Map every in-scope finding ID before confirming the plan; do not stop after the first missing item
