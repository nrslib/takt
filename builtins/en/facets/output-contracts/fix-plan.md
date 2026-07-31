```markdown
# Fix Plan

## Result: Fix plan finalized / Task-level replanning required

## Target Findings
| Finding ID / Source | Defect Family | Root Cause | Acceptance Criteria |
|---------------------|---------------|------------|---------------------|
| {ID or report name} | {family} | {Cause verified in code} | {Completion condition} |

## Affected Paths
| Family | Branches, Callers, Configuration Inputs, and Outputs | Evidence |
|--------|------------------------------------------------------|----------|
| {family} | {Affected paths} | {file:line} |

## Execution Order
| Order | Fix Unit | Dependencies | Targets | Completion Criteria |
|-------|----------|--------------|---------|---------------------|
| {N} | {Fix unit} | {Prior units or None} | {file:line} | {Verifiable condition} |

## Verification Strategy
| Family | Regression Test | Quality Gates |
|--------|-----------------|---------------|
| {family} | {Behavior and observation point} | {Commands} |

## Replanning Requirements
- {None, or evidence preventing a sound fix plan and the decision required}
```
