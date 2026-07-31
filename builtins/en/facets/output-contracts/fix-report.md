```markdown
# Fix Report
## Summary
{Summary of the work result, changes, and evidence}

## Fix Units
| Fix Unit | Target Findings | Authoritative Contract and Complete Invariant Set | Implementation and Participating Paths | Happy-Path, Failure-Path, and Boundary Evidence | Status |
|----------|-----------------|---------------------------------------------------|----------------------------------------|-------------------------------------------------|--------|
| {Stable ID from the plan} | {IDs} | {Completion conditions beyond the finding examples} | {Boundary change, every consumer migration, removal, or local fix} | {Tests or reproduction results} | {Complete only after every operation / replan / blocker} |

## Acceptance Criteria
| Finding ID | Acceptance Criterion | Evidence | Status |
|------------|----------------------|----------|--------|
| {ID} | {Expected behavior} | {Test or reproducible verification result} | {Complete / disputed / blocker} |

## Verification
| Type | Result | Evidence |
|------|--------|----------|
| {Build / Test / Other} | {Passed / Failed / Not run} | {Command or verification details} |

## Unresolved Items
- {None, or unresolved finding, reason, and required next action}
```
